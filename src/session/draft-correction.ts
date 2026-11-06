// SQ-CV-02: model interpretation selects scoped references; only code can apply and validate the edit.
import { parseAmountText } from '../amounts/parse.js';
import { LlmFailed } from '../contracts/llm.js';
import type { StepContext } from '../contracts/step.js';
import type { ChainId, MessageInput, Token } from '../contracts/types.js';
import { detectSecret } from '../guard/secrets.js';
import { extractUrls } from '../guard/urls.js';
import { fillSlots, loadPromptTemplate } from '../llm/prompt-builder/amounts.js';
import { compileEphemeral } from '../schemas/index.js';
import { collectDraftValues, type DraftValues } from './draft-values.js';

export interface PaymentDraft {
  amount: string;
  token: Token;
  recipient: string;
  chain_id: ChainId;
}

/** Only a single trusted, absolute, unsubmitted payment can supply omitted fields automatically. */
export function currentPaymentDraft(ctx: StepContext): PaymentDraft | null {
  const { req, repos } = ctx;
  if (
    req.state !== 'AWAITING_CONFIRMATION' ||
    req.handoff_attempts !== 0 ||
    repos.handoffs.get(req.request_id) ||
    req.untrusted.length !== 0 ||
    req.payments?.length !== 1 ||
    req.recipients.length !== 1 ||
    req.resolved.length !== 1
  )
    return null;
  const payment = req.payments[0]!;
  const actions = req.plan?.filter((intent) => intent.intent_id !== 'j');
  const planned = actions?.[0];
  if (payment.kind !== 'i' || payment.amount === null || actions?.length !== 1 || planned?.intent_id !== 'i')
    return null;
  const amount = repos.db1.get(payment.amount);
  const source = req.amounts.find((item) => item.placeholder === payment.amount);
  const recipient = repos.db3.get(payment.recipient);
  if (
    !amount?.confirmed ||
    amount.source !== 'user' ||
    amount.session_id !== req.session_id ||
    source?.relative !== null ||
    !recipient ||
    recipient.kind !== 'single' ||
    recipient.address === null ||
    recipient.source === 'untrusted' ||
    recipient.session_id !== req.session_id ||
    planned.recipients.length !== 1 ||
    planned.recipients[0]?.amount !== payment.amount ||
    planned.recipients[0]?.recipient !== payment.recipient ||
    !parseAmountText(amount.amount, amount.token).ok
  )
    return null;
  return {
    amount: amount.amount,
    token: amount.token,
    recipient: recipient.ens_name ?? recipient.address,
    chain_id: planned.chain_id,
  };
}

export type DraftCorrection =
  | { kind: 'replace'; input: MessageInput }
  | { kind: 'clarify'; message: string }
  | { kind: 'chat' }
  | { kind: 'new_request' };

interface Decision {
  session_id: string;
  draft_revision: string;
  turn_id: string;
  action: 'edit_draft' | 'chat' | 'new_request' | 'clarify';
  changes: { amount_ref: string | null; recipient_ref: string | null; token: Token | null; chain_id: ChainId | null };
  reason: 'amount' | 'recipient' | 'token' | 'chain' | 'ambiguous' | 'unsupported' | null;
}

const TEMPLATE = loadPromptTemplate('draft-edit.txt');
const CLARIFICATION = {
  amount: 'What exact amount should replace the current amount? Your draft is unchanged.',
  recipient: 'Who should receive this payment? Your draft is unchanged.',
  token: 'Should this payment use ETH or USDC? Your draft is unchanged.',
  chain: 'Which testnet should this payment use? Your draft is unchanged.',
  ambiguous: 'Which change should I make to this payment? Your draft is unchanged.',
  unsupported:
    'I can edit the amount, recipient, token or network of this single payment. For a different payment type, cancel this draft and give the full request.',
};
const clarify = (reason: keyof typeof CLARIFICATION = 'ambiguous'): DraftCorrection => ({
  kind: 'clarify',
  message: CLARIFICATION[reason],
});

function decisionSchema(values: DraftValues) {
  const ref = (items: readonly { placeholder: string; valid: boolean }[]) => ({
    type: ['string', 'null'],
    enum: [null, ...items.filter((v) => v.valid).map((v) => v.placeholder)],
  });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['session_id', 'draft_revision', 'turn_id', 'action', 'changes', 'reason'],
    properties: {
      session_id: { type: 'string', const: values.session_id },
      draft_revision: { type: 'string', const: values.draft_revision },
      turn_id: { type: 'string', const: values.turn_id },
      action: { type: 'string', enum: ['edit_draft', 'chat', 'new_request', 'clarify'] },
      changes: {
        type: 'object',
        additionalProperties: false,
        required: ['amount_ref', 'recipient_ref', 'token', 'chain_id'],
        properties: {
          amount_ref: ref(values.amounts),
          recipient_ref: ref(values.recipients),
          token: { type: ['string', 'null'], enum: [null, ...values.tokens] },
          chain_id: { type: ['integer', 'null'], enum: [null, ...values.chains] },
        },
      },
      reason: { type: ['string', 'null'], enum: [null, ...Object.keys(CLARIFICATION)] },
    },
  };
}

/** No raw amount/address, full contact book, previous turns or DB rows enter this prompt. */
function interpreterContext(current: PaymentDraft, values: DraftValues) {
  const metadata = (items: DraftValues['amounts']) =>
    items.map((v, index) => ({
      placeholder: v.placeholder,
      valid: v.valid,
      same_as_current: index === 0,
      ...(v.explicit_token === undefined ? {} : { explicit_token: v.explicit_token }),
    }));
  return {
    session_id: values.session_id,
    draft_revision: values.draft_revision,
    turn_id: values.turn_id,
    current_draft: {
      amount_ref: values.amounts[0]!.placeholder,
      recipient_ref: values.recipients[0]!.placeholder,
      token: current.token,
      chain_id: current.chain_id,
    },
    latest_message: values.masked,
    amounts: metadata(values.amounts),
    recipients: metadata(values.recipients),
    available_tokens: values.tokens,
    available_chains: values.chains,
    contains_group_schedule_or_split: values.complex,
  };
}

/** Separate from eligibility so reference/precision tests can exercise untrusted injected model clients. */
export async function interpretDraftEdit(
  ctx: StepContext,
  current: PaymentDraft,
  text: string,
): Promise<DraftCorrection> {
  const values = await collectDraftValues(ctx, current, text);
  if (!values) return clarify();
  const schema = decisionSchema(values);
  const decision = await ctx.llm.call<Decision>({
    name: 'draft_edit',
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { context_json: JSON.stringify(interpreterContext(current, values)) }),
    schema,
    think: false,
  });
  // Real Ollama validates too; injected clients and later adapters receive the same enforcement.
  if (!compileEphemeral(schema)(decision)) return clarify();
  if (decision.action !== 'edit_draft') {
    if (Object.values(decision.changes).some((v) => v !== null)) return clarify();
    if (decision.action === 'clarify') return clarify(decision.reason ?? 'ambiguous');
    if (decision.reason !== null) return clarify();
    return { kind: decision.action };
  }
  if (decision.reason !== null || values.complex) return clarify('unsupported');
  const patch = decision.changes;
  const amount =
    patch.amount_ref === null ? values.amounts[0]! : values.amounts.find((v) => v.placeholder === patch.amount_ref)!;
  const recipient =
    patch.recipient_ref === null
      ? values.recipients[0]!
      : values.recipients.find((v) => v.placeholder === patch.recipient_ref)!;
  const token = patch.token ?? (patch.amount_ref !== null ? amount.explicit_token : undefined) ?? current.token;
  if (patch.amount_ref !== null && amount.explicit_token !== undefined && amount.explicit_token !== token)
    return clarify('token');
  const parsed = parseAmountText(amount.value, token);
  if (!parsed.ok) return clarify('amount');
  const draft: PaymentDraft = {
    amount: parsed.value,
    token,
    recipient: recipient.value,
    chain_id: patch.chain_id ?? current.chain_id,
  };
  if (Object.entries(draft).every(([key, value]) => current[key as keyof PaymentDraft] === value)) return clarify();
  const chain = ctx.config.chains.find((c) => c.chain_id === draft.chain_id);
  if (!chain) return clarify('chain');
  return {
    kind: 'replace',
    input: {
      text: `send ${draft.amount} ${draft.token.toLowerCase()} to ${draft.recipient} on ${chain.name}`,
      attachments: [],
      pasted_blocks: [],
      urls: [],
    },
  };
}

/** Native confirmation/cancellation is handled before this entry point and never delegated to the model. */
export async function prepareDraftCorrection(ctx: StepContext, input: MessageInput): Promise<DraftCorrection | null> {
  if (
    input.attachments.length ||
    input.pasted_blocks.length ||
    input.urls.length ||
    detectSecret(input.text) !== null ||
    extractUrls(input.text, []).links.length
  )
    return null;
  const current = currentPaymentDraft(ctx);
  // Other draft kinds still require a complete new request through the normal pipeline.
  if (!current) return null;
  try {
    return await interpretDraftEdit(ctx, current, input.text);
  } catch (error) {
    if (!(error instanceof LlmFailed)) throw error;
    return { kind: 'clarify', message: "I couldn't interpret that change. Your draft is unchanged; please try again." };
  }
}
