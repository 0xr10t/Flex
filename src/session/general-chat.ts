// SQ-CHAT-01: guarded general chat with separate thinking control; no wallet tools or durable chat storage.
import { LlmFailed, type LlmClient } from '../contracts/llm.js';
import type { ErrorCode, QuestionCode } from '../contracts/types.js';
import { detectSecret } from '../guard/secrets.js';
import { extractUrls, urlHasSecret } from '../guard/urls.js';
import { fillSlots, loadPromptTemplate } from '../llm/prompt-builder/amounts.js';
import { compileEphemeral } from '../schemas/index.js';

export interface ChatTurn {
  user: string;
  assistant: string;
}

export interface ChatContext {
  state: string;
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
const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent'],
  properties: { intent: { type: 'string', enum: ['chat', 'wallet'] } },
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
  return JSON.stringify({
    latest_message: text,
    wallet_context: {
      state: context.state,
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
): Promise<'chat' | 'wallet'> {
  const output = await llm.call<{ intent: 'chat' | 'wallet' }>({
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
  return reply;
}

export function rememberChat(history: readonly ChatTurn[], user: string, assistant: string): ChatTurn[] {
  if (!guarded(user) || !guarded(assistant)) throw new LlmFailed('chat');
  return boundedHistory([...history, { user, assistant }]);
}
