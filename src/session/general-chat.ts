// SQ-CHAT-01: guarded general chat with separate thinking control; no wallet tools or durable chat storage.
// SQ-CHAT-02: read-only wallet questions select exact code-rendered facts from the background-updated balance cache.
import { LlmFailed, type LlmClient } from '../contracts/llm.js';
import type { ErrorCode, QuestionCode } from '../contracts/types.js';
import { detectSecret } from '../guard/secrets.js';
import { extractUrls, urlHasSecret } from '../guard/urls.js';
import { fillSlots, loadPromptTemplate } from '../llm/prompt-builder/amounts.js';
import { compileEphemeral } from '../schemas/index.js';
import type { WalletContext } from './wallet-context.js';

export interface ChatTurn {
  user: string;
  assistant: string;
}

export interface ChatContext {
  state: string;
  wallet_address?: string;
  wallet?: WalletContext;
  original_request?: string;
  pending_summary?: { text: string; notes: readonly string[] };
  question_code?: QuestionCode;
  guidance?: string;
  last_error?: ErrorCode;
  older_chat_omitted?: boolean;
}

export class ChatInputTooLong extends Error {
  constructor() {
    super('Chat input exceeds its context limit');
    this.name = 'ChatInputTooLong';
  }
}

const ROUTE = loadPromptTemplate('chat-route.txt');
const REPLY = loadPromptTemplate('chat.txt');
const WALLET_REPLY = loadPromptTemplate('wallet-chat.txt');
const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent'],
  properties: { intent: { type: 'string', enum: ['chat', 'wallet', 'wallet_info'] } },
};
const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: { reply: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' } },
};
const validateRoute = compileEphemeral(ROUTE_SCHEMA);
const validateReply = compileEphemeral(REPLY_SCHEMA);
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

function guarded(text: string): boolean {
  return detectSecret(text) === null && !extractUrls(text, []).links.some((link) => urlHasSecret(link.url));
}

function boundedHistory(history: readonly ChatTurn[]): ChatTurn[] {
  const recent: ChatTurn[] = [];
  let bytes = 0;
  for (const turn of history.slice(-6).reverse()) {
    const size = byteLength(turn.user) + byteLength(turn.assistant);
    if (bytes + size > 4000) break;
    if (!guarded(turn.user) || !guarded(turn.assistant)) throw new LlmFailed('chat');
    recent.unshift({ user: turn.user, assistant: turn.assistant });
    bytes += size;
  }
  return recent;
}

function promptContext(text: string, context: ChatContext, history: readonly ChatTurn[]): string {
  if (byteLength(text) > 4000) throw new ChatInputTooLong();
  if (!guarded(text)) throw new LlmFailed('chat');
  const original = context.original_request ?? '';
  const guidance = context.guidance ?? '';
  if (!guarded(original) || !guarded(guidance)) throw new LlmFailed('chat');
  const summary = context.pending_summary;
  if (summary !== undefined && (!guarded(summary.text) || summary.notes.some((note) => !guarded(note)))) {
    throw new LlmFailed('chat');
  }
  const summaryTooLarge = summary !== undefined && byteLength(JSON.stringify(summary)) > 4000;
  const recent = boundedHistory(history);
  if (context.wallet_address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(context.wallet_address))
    throw new LlmFailed('chat');
  if (context.wallet !== undefined && !guarded(JSON.stringify(context.wallet))) throw new LlmFailed('chat');
  return JSON.stringify({
    latest_message: text,
    wallet_context: {
      state: context.state,
      wallet_address: context.wallet_address ?? null,
      wallet: context.wallet ?? null,
      original_request: byteLength(original) <= 4000 ? original : null,
      original_request_omitted: byteLength(original) > 4000,
      pending_summary: summaryTooLarge ? null : (summary ?? null),
      pending_summary_omitted: summaryTooLarge,
      question_code: context.question_code ?? null,
      question_guidance: byteLength(guidance) <= 2000 ? guidance : null,
      last_error: context.last_error ?? null,
    },
    recent_chat: recent,
    older_chat_omitted: context.older_chat_omitted === true || recent.length !== history.length,
  });
}

export async function classifyChatMessage(
  llm: LlmClient,
  text: string,
  context: ChatContext,
  history: readonly ChatTurn[],
): Promise<'chat' | 'wallet' | 'wallet_info'> {
  const output = await llm.call<{ intent: 'chat' | 'wallet' | 'wallet_info' }>({
    name: 'chat_route',
    system: ROUTE.system,
    user: fillSlots(ROUTE.user, { context_json: promptContext(text, context, history) }),
    schema: ROUTE_SCHEMA,
    think: false,
  });
  if (!validateRoute(output)) throw new LlmFailed('chat_route');
  return output.intent;
}

export async function generateChatReply(
  llm: LlmClient,
  text: string,
  context: ChatContext,
  history: readonly ChatTurn[],
  think: boolean,
): Promise<string> {
  const output = await llm.call<{ reply: string }>({
    name: 'chat',
    system: REPLY.system,
    user: fillSlots(REPLY.user, { context_json: promptContext(text, context, history) }),
    schema: REPLY_SCHEMA,
    think,
  });
  if (!validateReply(output) || !guarded(output.reply)) throw new LlmFailed('chat');
  // Strip non-printing controls while preserving line breaks and tabs.
  // eslint-disable-next-line no-control-regex
  const reply = output.reply.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!reply || !guarded(reply)) throw new LlmFailed('chat');
  if (context.wallet_address !== undefined) {
    const known = new Set(
      [context.wallet_address, ...(context.pending_summary?.text.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])].map((address) =>
        address.toLowerCase(),
      ),
    );
    if ([...reply.matchAll(/0x[0-9a-fA-F]{40}\b/g)].some(([address]) => !known.has(address.toLowerCase())))
      throw new LlmFailed('chat');
  }
  return reply;
}

/** The model chooses relevant facts; amounts, addresses and their labels are rendered solely from the DB4 snapshot. */
export async function generateWalletReply(
  llm: LlmClient,
  text: string,
  context: ChatContext,
  history: readonly ChatTurn[],
  think: boolean,
): Promise<string> {
  const wallet = context.wallet;
  if (wallet === undefined) throw new LlmFailed('chat');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['facts'],
    properties: {
      facts: {
        type: 'array',
        minItems: 1,
        maxItems: 24,
        uniqueItems: true,
        items: { enum: Object.keys(wallet.facts) },
      },
    },
  };
  const output = await llm.call<{ facts: string[] }>({
    name: 'chat',
    system: WALLET_REPLY.system,
    user: fillSlots(WALLET_REPLY.user, { context_json: promptContext(text, context, history) }),
    schema,
    think,
  });
  if (!compileEphemeral(schema)(output)) throw new LlmFailed('chat');
  return output.facts.map((id) => wallet.facts[id]!).join('\n');
}

export function rememberChat(history: readonly ChatTurn[], user: string, assistant: string): ChatTurn[] {
  if (!guarded(user) || !guarded(assistant)) throw new LlmFailed('chat');
  return boundedHistory([...history, { user, assistant }]);
}
