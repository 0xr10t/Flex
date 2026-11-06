// Read-only status follow-ups never create requests, call models/RPC, or retry execution.
import type { ExecutionClient } from '../contracts/io.js';
import type { Repos } from '../contracts/repos.js';
import type { Address, AgentRequest, ChainConfig, ErrorCode } from '../contracts/types.js';
import { isAwaitingAnswer } from './request.js';

const SUBJECT = String.raw`(?:(?:(?:my|the|this|that|last|latest|previous)(?: (?:last|latest|previous))? )?(?:transaction|payment|transfer|request|autopay|cancellation)|it)`;
const STATUS_QUESTIONS = [
  `(?:did|has) ${SUBJECT} (?:go(?:ne)? through|succeed(?:ed)?|complete(?:d)?|fail(?:ed)?|finish(?:ed)?|work(?:ed)?|get (?:sent|confirmed|broadcast|mined))`,
  `(?:is|was|has) ${SUBJECT} (?:been )?(?:sent|successful|complete|completed|confirmed|pending|failed|broadcast|mined|done|executed)`,
  `(?:what is|check|show(?: me)?|tell me) (?:the )?(?:status (?:of|for) ${SUBJECT}|${SUBJECT}(?:'s)? status)`,
  `(?:what happened to|any updates? on) ${SUBJECT}`,
  `check (?:if|whether) ${SUBJECT} (?:went through|was successful|was confirmed|was sent|failed)`,
  'did (?:you|we) (?:send|broadcast) (?:it|the (?:payment|transaction))',
  '(?:what is (?:the )?|show(?: me)? (?:the )?|check (?:the )?)?(?:payment|transaction|transfer) status',
].map((pattern) => new RegExp(`^(?:${pattern})(?: yet)?$`));

/** Match the whole question: never swallow an appended send, retry, cancellation, name or hash. */
export function isTransactionStatusQuery(text: string): boolean {
  if (text.length > 500) return false;
  const question = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?!.]+$/, '')
    .trim()
    .replace(/^please /, '')
    .replace(/ please$/, '')
    .replace(/^(?:can|could|would) you (?:please )?(?=check|show|tell)/, '')
    .replace(/^what's /, 'what is ');
  return STATUS_QUESTIONS.some((pattern) => pattern.test(question));
}

export function isPaymentRequest(req: AgentRequest): boolean {
  return Boolean(req.actions?.length || req.plan?.length || req.envelope || req.handoff_attempts);
}

export interface TransactionStatus {
  summary: string;
  details: string[];
}

export function readTransactionStatus(
  req: AgentRequest | undefined,
  options: {
    repos: Repos;
    exec: ExecutionClient;
    walletAddress: Address;
    chains: readonly ChainConfig[];
    lastError?: ErrorCode;
  },
): TransactionStatus {
  const result = (summary: string, details: string[] = []): TransactionStatus => ({ summary, details });
  if (!req) return result('I have no payment request to check in this session.');
  const { repos, exec } = options;
  const saved = repos.handoffs.get(req.request_id);
  if (saved && saved.envelope.wallet_address.toLowerCase() !== options.walletAddress.toLowerCase())
    return result('I have no matching payment request for the connected wallet in this session.');
  if (exec.wasCapturedLocally?.(req.request_id))
    return result('No. Your payment plan was captured locally. Nothing was signed or broadcast.');
  if (!saved) {
    if (req.handoff_attempts || options.lastError === 'EXECUTION_UNAVAILABLE')
      return result(
        'I cannot confirm the submission result. Your wallet may have received the request. Check its activity before retrying.',
      );
    if (req.state === 'AWAITING_CONFIRMATION')
      return result('Not yet. This request is waiting for your confirmation; it has not been sent to your wallet.');
    if (isAwaitingAnswer(req))
      return result(
        'Not yet. I still need your answer to the open question before this request can be confirmed or sent.',
      );
    if (req.state === 'DISCARDED') return result('No. This request was discarded before it was sent to your wallet.');
    if (req.state === 'FAILED') return result('No. This request stopped before it was sent to your wallet.');
    return result('I do not have an execution result for this request.');
  }
  if (saved.status === 'rejected')
    return result('Your wallet rejected this request. It was not accepted for execution.');

  const rows = repos.db6.listByRequest(req.request_id);
  const name = (id: number) => options.chains.find((chain) => chain.chain_id === id)?.name ?? `chain ${id}`;
  const steps = saved.envelope.intents.map((intent) => {
    if (intent.intent_id === 'k' || intent.intent_id === 'l') {
      const autopay = repos.db7.get(intent.autopay_id);
      // DB7 is the schedule's current state, not a receipt for this particular registration/cancel request.
      // In particular, an already-cancelled schedule does not prove a new cancellation was executed.
      return {
        status: 'pending',
        detail: `Autopay ${intent.intent_id === 'k' ? 'registration' : 'cancellation'} on ${name(intent.chain_id)}: schedule ${autopay?.status ?? 'unknown'}. This does not confirm an individual payment or transaction.`,
      };
    }
    const matching = rows.filter(
      (row) => row.step === intent.step && row.kind === (intent.intent_id === 'i' ? 'payment' : 'bridge_out'),
    );
    const expected = intent.intent_id === 'i' ? intent.recipients.length : 1;
    const status =
      matching.length === expected && matching.every((row) => row.status === 'executed')
        ? 'executed'
        : matching.some((row) => row.status === 'failed')
          ? 'failed'
          : 'pending';
    const label =
      intent.intent_id === 'i'
        ? `Payment on ${name(intent.chain_id)}`
        : `Bridge from ${name(intent.source_chain_id)} to ${name(intent.dest_chain_id)}`;
    const hashes = [
      ...new Set(
        matching.flatMap((row) => (row.tx_hash && /^0x[0-9a-f]{64}$/i.test(row.tx_hash) ? [row.tx_hash] : [])),
      ),
    ];
    const detail = `${label}: ${status === 'executed' ? 'your wallet reported completion' : status === 'failed' ? 'your wallet reported failure' : 'no completion report received'}.`;
    return { status, detail: [detail, ...hashes.map((hash) => `Transaction: ${hash}`)].join('\n') };
  });
  const details = steps.map((step) => step.detail);
  const executed = steps.filter((step) => step.status === 'executed').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  if (executed === steps.length && steps.length)
    return result('Your wallet reports that all payment and bridge steps in this request completed.', details);
  if (executed)
    return result(
      'This request is only partly complete. Some steps completed, but the whole request has not been confirmed as successful.',
      details,
    );
  if (failed)
    return result(
      'Your wallet reported a failure. This request has not been confirmed as successful; check your wallet activity before retrying.',
      details,
    );
  if (saved.status === 'submitted')
    return result(
      'I cannot confirm whether your wallet accepted this request. It may have received it, so check its activity before retrying.',
      details,
    );
  return result('Your wallet accepted the request, but I have not received confirmation that it completed.', details);
}
