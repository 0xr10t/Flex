// Implements: §8.7 S6, §9 recipient resolution (§9.1 names, §9.2 addresses, §9.3 ENS names, §9.4 ENS re-check,
// §9.6 group sends, §9.7 ordering and attempt counting), §13.4 answer parsing for Q_WHO_IS, Q_ADDRESS_CORRECT,
// Q_ADDRESS_REENTER, Q_NAME_FOR_ADDRESS, Q_ENS_CHAIN, Q_ENS_CHANGED, Q_GROUP_PARENT, Q_GROUP_CHAIN,
// Q_GROUP_MEMBERS (and Q_NO_PAYEE when every document payee was dropped), §16.1 untrusted addresses,
// §7.2 / §16.4 DB2 written only by add_contact after "Yes" + name, §15 SELF_PAYMENT / ENS_INDEXER_UNAVAILABLE /
// GROUP_EMPTY / TOO_MANY_RETRIES.

import {
  CHIPS,
  ENS_CHAIN_CHIP_LABEL,
  MEMBER_UNPAYABLE_DETAIL,
  NOTES,
  QUESTION_TEXT,
  REPLY,
  QUESTION_VARIANT,
  REASK_HINT,
  SKIP_REASON,
  buildQuestion,
  matchChip,
  withHint,
} from '../contracts/catalog.js';
import { EnsUnavailable, IndexerUnavailable } from '../contracts/io.js';
import { shortAddress } from '../contracts/money.js';
import type { Db2Row } from '../contracts/repos.js';
import type { StepContext, StepResult } from '../contracts/step.js';
import type {
  Address,
  Answer,
  ChainId,
  Chip,
  GroupMember,
  GroupPh,
  Question,
  QuestionCode,
  QuestionId,
  RecipientSpan,
  ResolvedRecipient,
} from '../contracts/types.js';
import { newId } from '../util/ids.js';
import { checkAddress, isSelf, looksLikeAddress, type AddressCheck } from './address.js';
import { chainName, joinNames, okChains, statedChain } from './chains.js';
import { firstLabel, normalizeEns, resolveOnChain, resolveOnChains, type ChainAddress } from './ens.js';
import { resolveMembers, triageMembers } from './group.js';
import { checkContactName, closeContacts, nameKey } from './names.js';
import { s6State, type EnsInfo, type Flow, type Origin, type S6State } from './state.js';

const MAX_ATTEMPTS = 4;

type Resolved = Omit<ResolvedRecipient, 'span_index'>;

/** Result of driving one payee one step further. */
type Outcome =
  | { k: 'resolved'; r: Resolved; group_ph?: GroupPh }
  /** `base` = the question text without a re-ask hint (defaults to the question text). */
  | { k: 'ask'; flow: Flow; question: Question; base?: string }
  | { k: 'removed' }
  | { k: 'stop'; result: StepResult };

const qid = (): QuestionId => newId('question') as QuestionId;

function ask(flow: Flow, question: Question, base?: string): Outcome {
  return base === undefined ? { k: 'ask', flow, question } : { k: 'ask', flow, question, base };
}

function stop(result: StepResult): Outcome {
  return { k: 'stop', result };
}

/** SQ-19 / §0: a state the spec does not cover → UNSUPPORTED_REQUEST, internal state code logged. */
function unsupported(ctx: StepContext, rule_id: string): Outcome {
  ctx.log.warn({
    event: 'unsupported_state',
    step: 's6',
    state: ctx.req.state,
    rule_id,
    request_id: ctx.req.request_id,
  });
  return stop({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });
}

/** Re-asks the pending question (§9.7): attempt + 1, optional hint before the base text; 4th failure → error. */
function again(st: S6State, q: Question, hint?: string, text?: string): StepResult {
  if (q.attempt >= MAX_ATTEMPTS) return { kind: 'error', code: 'TOO_MANY_RETRIES' };
  const base = text ?? st.pending?.base_text ?? q.text;
  const question: Question = {
    ...q,
    question_id: qid(),
    attempt: q.attempt + 1,
    text: hint !== undefined ? withHint(hint, base) : base,
  };
  st.pending = { question, base_text: base };
  return { kind: 'question', question };
}

// ───────────────────────────── resolved builders ─────────────────────────────

function contactResolved(rows: Db2Row[]): Resolved {
  const first = rows[0] as Db2Row;
  return {
    kind: 'single',
    display_name: first.name,
    address: first.address,
    ens_name: rows.find((r) => r.ens_name !== null)?.ens_name ?? null,
    source: 'contact',
    is_contact: true,
    contact_chain_ids: rows.map((r) => r.chain_id),
    ens_chain_ids: [],
    pinned_chain_id: null,
  };
}

// ───────────────────────────── §9.4 ENS re-check ─────────────────────────────

async function contactOutcome(ctx: StepContext, rows: Db2Row[]): Promise<Outcome> {
  const all = ctx.repos.db2.findByNameKey((rows[0] as Db2Row).name_key);
  const contactRows = all.length > 0 ? all : rows;
  const resolved = contactResolved(contactRows);
  if (resolved.ens_name === null) return { k: 'resolved', r: resolved };
  return recheck(ctx, resolved, contactRows);
}

async function recheck(ctx: StepContext, resolved: Resolved, rows: Db2Row[]): Promise<Outcome> {
  const ens = resolved.ens_name as string;
  const saved = resolved.address as Address;
  const results: Array<Address | null> = [];
  try {
    for (const chain_id of [...new Set(rows.map((r) => r.chain_id))]) {
      results.push(await resolveOnChain(ctx.ens, ctx.config, ens, chain_id));
    }
  } catch (e) {
    if (!(e instanceof EnsUnavailable)) throw e;
    // §9.4 "RPC unavailable": use the saved address; note.
    ctx.req.notes.push(NOTES.ENS_RECHECK_FAILED({ ens }));
    return { k: 'resolved', r: resolved };
  }
  const different = [...new Set(results.filter((a): a is Address => a !== null && !sameAddr(a, saved)))];
  // spec-questions/C.md SQ-C-02: §9.4 has one "new address"; several differing chains are not covered.
  if (different.length > 1) return unsupported(ctx, 'ens_recheck_several_new_addresses');
  const fresh = different[0];
  if (fresh !== undefined) {
    const flow: Flow = { t: 'ens_changed', name_key: (rows[0] as Db2Row).name_key, ens, saved, fresh };
    return ask(
      flow,
      buildQuestion({
        question_id: qid(),
        code: 'Q_ENS_CHANGED',
        params: { ens, new: shortAddress(fresh), old: shortAddress(saved) },
        chips: [CHIPS.ENS_USE_NEW, CHIPS.ENS_KEEP, CHIPS.CANCEL],
      }),
    );
  }
  if (results.some((a) => a !== null)) return { k: 'resolved', r: resolved };
  const flow: Flow = { t: 'ens_changed', name_key: (rows[0] as Db2Row).name_key, ens, saved, fresh: null };
  return ask(
    flow,
    buildQuestion({
      question_id: qid(),
      code: 'Q_ENS_CHANGED',
      text: QUESTION_VARIANT.ENS_CHANGED_NO_ADDRESS({ ens }),
      chips: [CHIPS.ENS_KEEP, CHIPS.CANCEL],
    }),
  );
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ───────────────────────────── §9.1 names ─────────────────────────────

async function nameFlow(ctx: StepContext, text: string, origin: Origin): Promise<Outcome> {
  const key = nameKey(text);
  const rows = ctx.repos.db2.findByNameKey(key);
  if (rows.length > 0) return contactOutcome(ctx, rows);
  if (text.includes('.')) return ensFlow(ctx, text, origin, 1);
  return ask({ t: 'who_is', origin }, whoIsQuestion(ctx, text));
}

function whoIsQuestion(ctx: StepContext, name: string, text?: string): Question {
  const chips: Chip[] = closeContacts(ctx.repos.db2.listAll(), nameKey(name)).map((c) => ({
    id: `contact:${c.name_key}`,
    label: c.name,
    disabled: false,
    detail: '',
  }));
  return buildQuestion({
    question_id: qid(),
    code: 'Q_WHO_IS',
    params: { name },
    ...(text !== undefined ? { text } : {}),
    chips,
  });
}

// ───────────────────────────── §9.3 ENS names ─────────────────────────────

/** `attempt` is used for the address questions this flow asks (the §9.7 loop counter when re-entered). */
async function ensFlow(ctx: StepContext, raw: string, origin: Origin, attempt: number): Promise<Outcome> {
  const name = normalizeEns(raw);
  if (name === null) {
    // §9.3 step 1.
    return ask({ t: 'who_is', origin }, whoIsQuestion(ctx, origin.text, QUESTION_VARIANT.WHO_IS_INVALID_ENS()));
  }
  // §9.3 step 2.
  const saved = ctx.repos.db2.findByEnsName(name);
  if (saved.length > 0) return contactOutcome(ctx, saved);
  // §9.3 step 3.
  const target = statedChain(ctx.req.scan, origin.clause_index);
  const chains = target !== null ? [target] : okChains(ctx);
  let found: ChainAddress[];
  try {
    found = await resolveOnChains(ctx.ens, ctx.config, name, chains);
  } catch (e) {
    // spec-questions/C.md SQ-C-01: the spec gives no outcome for a failed ENS lookup in §9.3.
    if (e instanceof EnsUnavailable) return unsupported(ctx, 'ens_lookup_unavailable');
    throw e;
  }
  // §9.3 step 4.
  if (found.length === 0) {
    return ask(
      { t: 'addr', stage: 'reenter', address: null, ens: null, attempt, origin },
      buildQuestion({
        question_id: qid(),
        code: 'Q_ADDRESS_REENTER',
        text: QUESTION_VARIANT.REENTER_ENS_NO_ADDRESS({ ens: name }),
        attempt,
      }),
    );
  }
  const distinct = [...new Set(found.map((f) => f.address))];
  if (distinct.length === 1) {
    // §9.3 step 5.
    const address = distinct[0] as Address;
    return addressChecked(
      ctx,
      address,
      origin,
      { name, chain_ids: found.map((f) => f.chain_id), pinned: null },
      attempt,
    );
  }
  // §9.3 step 6.
  const chips = found.map((f) => ({
    id: String(f.chain_id),
    label: ENS_CHAIN_CHIP_LABEL({ chain: chainName(ctx, f.chain_id), addr: shortAddress(f.address) }),
    disabled: false,
    detail: '',
  }));
  return ask(
    { t: 'ens_chain', name, found, origin, attempt },
    buildQuestion({ question_id: qid(), code: 'Q_ENS_CHAIN', params: { ens: name }, chips, attempt }),
  );
}

// ───────────────────────────── §9.2 addresses ─────────────────────────────

/** §9.2 step 1–2 failure → hint for the re-ask (format errors have no quoted hint). */
function addressHint(check: Extract<AddressCheck, { ok: false }>): string | undefined {
  if (check.reason === 'checksum') return REASK_HINT.CHECKSUM_TYPO();
  if (check.reason === 'zero') return REASK_HINT.ZERO_ADDRESS();
  return undefined;
}

function reenterBase(origin: Origin): string {
  return QUESTION_TEXT.Q_ADDRESS_REENTER(origin.suggested !== null ? { name: origin.suggested } : {});
}

function reenterQuestion(origin: Origin, attempt: number, hint?: string): Question {
  const base = reenterBase(origin);
  return buildQuestion({
    question_id: qid(),
    code: 'Q_ADDRESS_REENTER',
    text: hint !== undefined ? withHint(hint, base) : base,
    attempt,
  });
}

/** An address typed in the message (§9.2 step 1–2 applied before anything is asked). */
async function addressFromText(ctx: StepContext, text: string, origin: Origin): Promise<Outcome> {
  const check = checkAddress(text);
  if (check.ok) return addressChecked(ctx, check.address, origin, null, 1);
  // §9.2 steps 1–2 "re-ask": the address is asked for with Q_ADDRESS_REENTER, with the quoted hint.
  return ask(
    { t: 'addr', stage: 'reenter', address: null, ens: null, attempt: 1, origin },
    reenterQuestion(origin, 1, addressHint(check)),
    reenterBase(origin),
  );
}

/** §9.2 steps 3–5 for a valid checksummed address (ENS-resolved addresses enter here too, §9.3 step 7). */
function addressChecked(
  ctx: StepContext,
  address: Address,
  origin: Origin,
  ens: EnsInfo | null,
  attempt: number,
): Outcome {
  // Step 3.
  if (isSelf(address, ctx.config.wallet.address)) return stop({ kind: 'error', code: 'SELF_PAYMENT' });
  // Step 4.
  const rows = ctx.repos.db2.findByAddress(address);
  if (rows.length > 0) {
    const r = contactResolved(rows);
    if (ens !== null) {
      r.ens_chain_ids = ens.chain_ids;
      r.pinned_chain_id = ens.pinned;
    }
    return { k: 'resolved', r };
  }
  // Step 5.
  return ask(
    { t: 'addr', stage: 'correct', address, ens, attempt, origin },
    correctQuestion(ctx, address, ens, origin, attempt),
  );
}

function correctQuestion(
  ctx: StepContext,
  address: Address,
  ens: EnsInfo | null,
  origin: Origin,
  attempt: number,
): Question {
  // SQ-06 (a): plain full address, no emphasis markup.
  let text =
    ens !== null
      ? QUESTION_VARIANT.ADDRESS_CORRECT_ENS({
          ens: ens.name,
          addr: address,
          chains: joinNames(ens.chain_ids.map((c) => chainName(ctx, c))),
        })
      : QUESTION_TEXT.Q_ADDRESS_CORRECT({ addr: address });
  if (origin.untrusted) text = `${text} ${QUESTION_VARIANT.ADDRESS_CORRECT_UNTRUSTED_SUFFIX()}`;
  const chips = origin.untrusted ? [CHIPS.YES, CHIPS.NO_REENTER, CHIPS.DONT_PAY] : [CHIPS.YES, CHIPS.NO_REENTER];
  return buildQuestion({ question_id: qid(), code: 'Q_ADDRESS_CORRECT', text, chips, attempt });
}

function nameQuestion(prefill: string | null): Question {
  return buildQuestion({
    question_id: qid(),
    code: 'Q_NAME_FOR_ADDRESS',
    ...(prefill !== null ? { prefill } : {}),
  });
}

// ───────────────────────────── §9.6 groups ─────────────────────────────

function groupParentText(span: RecipientSpan, ctx: StepContext): string {
  const cand = ctx.req.scan.groups.find((g) => g.text === span.text);
  if (cand) return cand.parent;
  return span.text.trim().replace(/^@/, '');
}

async function groupAdvance(ctx: StepContext, flow: Extract<Flow, { t: 'group' }>): Promise<Outcome> {
  // Step 1.
  if (flow.parent === null) {
    return ask(
      { ...flow, stage: 'parent' },
      buildQuestion({ question_id: qid(), code: 'Q_GROUP_PARENT', attempt: flow.parent_attempt }),
    );
  }
  const parent = flow.parent;
  // Step 2.
  if (flow.chain_id === null) {
    const stated = statedChain(ctx.req.scan, flow.origin.clause_index);
    if (stated !== null) {
      flow.chain_id = stated;
    } else {
      const allowed = okChains(ctx);
      // spec-questions/C.md SQ-C-04: no allowed `ok` chain to offer.
      if (allowed.length === 0) return unsupported(ctx, 'group_chain_no_ok_chain');
      const chips = allowed.map((c) => ({
        id: String(c),
        label: chainName(ctx, c),
        disabled: false,
        detail: '',
      }));
      return ask({ ...flow, stage: 'chain' }, buildQuestion({ question_id: qid(), code: 'Q_GROUP_CHAIN', chips }));
    }
  }
  const chain_id = flow.chain_id;
  // Step 3.
  let children: string[] | 'not_found';
  try {
    children = await ctx.subnames.listChildren(parent);
  } catch (e) {
    if (e instanceof IndexerUnavailable) {
      return stop({ kind: 'error', code: 'ENS_INDEXER_UNAVAILABLE', params: { parent } });
    }
    throw e;
  }
  // Step 4.
  if (children === 'not_found') {
    if (flow.parent_attempt > MAX_ATTEMPTS) return stop({ kind: 'error', code: 'TOO_MANY_RETRIES' });
    return ask(
      { ...flow, stage: 'parent' },
      buildQuestion({
        question_id: qid(),
        code: 'Q_GROUP_PARENT',
        text: QUESTION_VARIANT.GROUP_PARENT_NOT_IN_ENS({ parent }),
        attempt: flow.parent_attempt,
      }),
    );
  }
  const chain = chainName(ctx, chain_id);
  // Step 5.
  if (children.length === 0) return stop({ kind: 'error', code: 'GROUP_EMPTY', params: { parent, chain } });
  // Steps 6–7.
  const lookups = await resolveMembers(ctx.ens, ctx.config, children, chain_id);
  const triage = triageMembers(lookups, ctx.config.wallet.address);
  const payable = triage.members.filter((m) => m.address !== null);
  // Step 8.
  if (payable.length === 0) return stop({ kind: 'error', code: 'GROUP_EMPTY', params: { parent, chain } });
  // Step 9.
  const chips: Chip[] = triage.members.map((m) => ({
    id: m.subname,
    label: m.subname,
    disabled: m.address === null,
    detail: m.address === null ? MEMBER_UNPAYABLE_DETAIL({ chain }) : '',
  }));
  return ask(
    { ...flow, stage: 'members', members: triage.members, self: triage.self },
    buildQuestion({
      question_id: qid(),
      code: 'Q_GROUP_MEMBERS',
      params: { n: String(payable.length), parent },
      chips,
    }),
  );
}

/** §9.6 step 10: DB3 group row + one member row per selected member; never DB2. Notes per step 7 / E4. */
function groupFinish(ctx: StepContext, flow: Extract<Flow, { t: 'group' }>, selected: Set<string>): Outcome {
  const parent = flow.parent as string;
  const chain_id = flow.chain_id as ChainId;
  const chain = chainName(ctx, chain_id);
  const base = { session_id: ctx.req.session_id, request_id: ctx.req.request_id };
  const group_ph = ctx.repos.db3.mint({
    ...base,
    kind: 'group',
    name: parent,
    address: null,
    ens_name: parent,
    chain_id,
    group_placeholder: null,
    source: 'ens',
  }) as GroupPh;
  const members: GroupMember[] = [];
  for (const m of flow.members) {
    const isSelected = m.address !== null && selected.has(m.subname);
    members.push({ subname: m.subname, address: m.address, payable: m.address !== null, selected: isSelected });
    if (isSelected) {
      ctx.repos.db3.mint({
        ...base,
        kind: 'member',
        name: m.subname,
        address: m.address,
        ens_name: m.subname,
        chain_id,
        group_placeholder: group_ph,
        source: 'ens',
      });
    }
  }
  for (const name of flow.self) ctx.req.notes.push(NOTES.SKIPPED({ name, reason: SKIP_REASON.OWN_ADDRESS() }));
  for (const m of flow.members) {
    if (m.address === null) {
      ctx.req.notes.push(NOTES.SKIPPED({ name: m.subname, reason: SKIP_REASON.NO_ADDRESS_ON({ chain }) }));
    }
  }
  return {
    k: 'resolved',
    group_ph,
    r: {
      kind: 'group',
      display_name: parent,
      address: null,
      ens_name: parent,
      source: 'ens',
      is_contact: false,
      contact_chain_ids: [],
      ens_chain_ids: [chain_id],
      pinned_chain_id: null,
      group: { parent, chain_id, members },
    },
  };
}

// ───────────────────────────── per-span entry ─────────────────────────────

function originOf(span: RecipientSpan): Origin {
  return {
    text: span.text,
    suggested: span.kind === 'name' ? span.text.trim() : null,
    untrusted: span.source === 'untrusted',
    clause_index: span.span?.clause_index ?? null,
  };
}

async function startSpan(ctx: StepContext, span: RecipientSpan): Promise<Outcome> {
  if (span.followup_placeholder !== null) {
    // §17.2 step 4: the earlier placeholder is reused; S7 writes no new DB3 row.
    const row = ctx.repos.db3.get(span.followup_placeholder);
    if (!row || row.address === null) return stop({ kind: 'error', code: 'INTERNAL_ERROR' });
    const contactRows = ctx.repos.db2.findByAddress(row.address);
    return {
      k: 'resolved',
      r: {
        kind: 'single',
        display_name: row.name ?? span.text,
        address: row.address,
        ens_name: row.ens_name,
        source: 'session',
        is_contact: contactRows.length > 0,
        contact_chain_ids: contactRows.map((r) => r.chain_id),
        ens_chain_ids: [],
        pinned_chain_id: row.chain_id,
      },
    };
  }
  const origin = originOf(span);
  switch (span.kind) {
    case 'name':
      return nameFlow(ctx, span.text, origin);
    case 'ens':
      return ensFlow(ctx, span.text, origin, 1);
    case 'address':
      return addressFromText(ctx, span.text, origin);
    case 'group': {
      const parent = normalizeEns(groupParentText(span, ctx));
      return groupAdvance(ctx, {
        t: 'group',
        stage: 'parent',
        parent,
        chain_id: null,
        parent_attempt: 1,
        members: [],
        self: [],
        origin,
      });
    }
  }
}

// ───────────────────────────── settle / step / answers ─────────────────────────────

/** Applies an outcome to the S6 state. Returns null when S6 should carry on with the next payee. */
function settle(ctx: StepContext, st: S6State, out: Outcome): StepResult | null {
  switch (out.k) {
    case 'resolved': {
      const span_index = st.index;
      ctx.req.resolved[span_index] = { ...out.r, span_index };
      ctx.req.resolved.length = span_index + 1;
      if (out.group_ph !== undefined) st.groups[span_index] = out.group_ph;
      st.index++;
      st.flow = null;
      st.pending = null;
      return null;
    }
    case 'removed':
      // §9.2 step 5: "Don't pay this one" removes this payee from the request.
      ctx.req.spans.splice(st.index, 1);
      st.removed++;
      st.flow = null;
      st.pending = null;
      return null;
    case 'ask':
      st.flow = out.flow;
      st.pending = { question: out.question, base_text: out.base ?? out.question.text };
      return { kind: 'question', question: out.question };
    case 'stop':
      st.flow = null;
      st.pending = null;
      return out.result;
  }
}

/** S6 step: resolves payees in order of appearance, one at a time (§8.7, §9.7). Re-entrant. */
export async function resolveStep(ctx: StepContext): Promise<StepResult> {
  const st = s6State(ctx.req);
  if (st.done) return { kind: 'continue' };
  if (st.pending !== null) return { kind: 'question', question: st.pending.question };
  while (st.index < ctx.req.spans.length) {
    const span = ctx.req.spans[st.index] as RecipientSpan;
    const res = settle(ctx, st, await startSpan(ctx, span));
    if (res !== null) return res;
  }
  if (ctx.req.spans.length === 0 && st.removed > 0) {
    // §9.2 step 5: no payees remain → Q_NO_PAYEE.
    const question = buildQuestion({ question_id: qid(), code: 'Q_NO_PAYEE' });
    return settle(ctx, st, ask({ t: 'no_payee' }, question)) as StepResult;
  }
  st.done = true;
  ctx.req.state = 'RECIPIENTS_RESOLVED';
  ctx.log.info({ event: 'recipients_resolved', step: 's6', request_id: ctx.req.request_id, n_payees: st.index });
  return { kind: 'continue' };
}

/** Continues after a handled answer: either the next question of the same payee, or re-enter S6. */
function proceed(ctx: StepContext, st: S6State, out: Outcome): StepResult {
  return settle(ctx, st, out) ?? { kind: 'continue' };
}

/** S6 AnswerHandler (§13.4 answer parsing, §9.7 re-asks). */
export async function resolveAnswer(ctx: StepContext, q: Question, answer: Answer): Promise<StepResult> {
  const st = s6State(ctx.req);
  const flow = st.flow;
  if (flow === null) return { kind: 'error', code: 'INTERNAL_ERROR' };
  const code: QuestionCode = q.code;
  switch (flow.t) {
    case 'who_is':
      return answerWhoIs(ctx, st, q, answer, flow.origin);
    case 'addr':
      if (code === 'Q_ADDRESS_CORRECT') return answerCorrect(ctx, st, q, answer, flow);
      if (code === 'Q_ADDRESS_REENTER') return answerReenter(ctx, st, q, answer, flow);
      return answerName(ctx, st, q, answer, flow);
    case 'ens_chain':
      return answerEnsChain(ctx, st, q, answer, flow);
    case 'ens_changed':
      return answerEnsChanged(ctx, st, q, answer, flow);
    case 'group':
      return answerGroup(ctx, st, q, answer, flow);
    case 'no_payee':
      return answerNoPayee(ctx, st, q, answer);
  }
}

const textOf = (a: Answer): string | null => (a.kind === 'text' ? a.text.trim() : null);
/** An ENS-looking free-text answer: one token containing a dot (§9.1 step 4, §13.4 address answers). */
const looksLikeEns = (t: string): boolean => t.includes('.') && !/\s/.test(t);

async function answerWhoIs(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  origin: Origin,
): Promise<StepResult> {
  const chip = matchChip(q, answer);
  if (chip !== null) {
    // §9.1 step 4: contact chip → that contact; no alias is saved.
    const rows = ctx.repos.db2.findByNameKey(chip.id.replace(/^contact:/, ''));
    if (rows.length === 0) return again(st, q);
    return proceed(ctx, st, await contactOutcome(ctx, rows));
  }
  const t = textOf(answer);
  if (t === null || t.length === 0) return again(st, q);
  if (looksLikeAddress(t)) {
    const check = checkAddress(t);
    if (!check.ok) return again(st, q, addressHint(check));
    // Address typed → §9.2 with suggested name = the original span text.
    return proceed(ctx, st, addressChecked(ctx, check.address, origin, null, 1));
  }
  if (looksLikeEns(t)) {
    if (normalizeEns(t) === null) return again(st, q, undefined, QUESTION_VARIANT.WHO_IS_INVALID_ENS());
    return proceed(ctx, st, await ensFlow(ctx, t, origin, 1));
  }
  return again(st, q);
}

async function answerCorrect(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  flow: Extract<Flow, { t: 'addr' }>,
): Promise<StepResult> {
  const chip = matchChip(q, answer);
  if (chip === null) {
    const res = again(st, q);
    if (res.kind === 'question') flow.attempt = res.question.attempt;
    return res;
  }
  if (chip.id === CHIPS.DONT_PAY.id) return proceed(ctx, st, { k: 'removed' });
  if (chip.id === CHIPS.YES.id) {
    const prefill = flow.ens !== null ? firstLabel(flow.ens.name) : flow.origin.suggested;
    return proceed(ctx, st, ask({ ...flow, stage: 'name' }, nameQuestion(prefill)));
  }
  // "No, re-enter" counts as a failed attempt (§9.7).
  if (flow.attempt >= MAX_ATTEMPTS) return { kind: 'error', code: 'TOO_MANY_RETRIES' };
  const attempt = flow.attempt + 1;
  return proceed(
    ctx,
    st,
    ask({ ...flow, stage: 'reenter', address: null, ens: null, attempt }, reenterQuestion(flow.origin, attempt)),
  );
}

async function answerReenter(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  flow: Extract<Flow, { t: 'addr' }>,
): Promise<StepResult> {
  const failed = (hint?: string, text?: string): StepResult => {
    const res = again(st, q, hint, text);
    if (res.kind === 'question') flow.attempt = res.question.attempt;
    return res;
  };
  const t = textOf(answer);
  if (t === null || t.length === 0) return failed();
  // The answer is typed by the user, so it is not content-sourced any more (spec-questions/C.md SQ-C-05).
  const origin: Origin = { ...flow.origin, untrusted: false };
  if (looksLikeAddress(t)) {
    const check = checkAddress(t);
    if (!check.ok) return failed(addressHint(check));
    return proceed(ctx, st, addressChecked(ctx, check.address, origin, null, q.attempt));
  }
  // §13.4: an ENS name typed where an address is asked goes through §9.3.
  const ens = looksLikeEns(t) ? normalizeEns(t) : null;
  if (ens !== null) {
    const out = await ensFlow(ctx, ens, origin, q.attempt);
    // An ENS name without an address is a failed answer to this question (§9.7), worded as §9.3 step 4.
    if (out.k === 'ask' && out.question.code === 'Q_ADDRESS_REENTER') {
      return failed(undefined, QUESTION_VARIANT.REENTER_ENS_NO_ADDRESS({ ens }));
    }
    return proceed(ctx, st, out);
  }
  return failed();
}

async function answerName(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  flow: Extract<Flow, { t: 'addr' }>,
): Promise<StepResult> {
  const t = textOf(answer);
  if (t === null) return again(st, q);
  const check = checkContactName(t, ctx.config, ctx.repos);
  if (!check.ok) return again(st, q, check.reason === 'taken' ? REASK_HINT.NAME_TAKEN() : undefined);
  const address = flow.address as Address;
  // §9.2 step 7 / §9.3 step 7: add_contact, the only DB2 write, after "Yes" + a valid name.
  const chain_ids = flow.ens !== null ? flow.ens.chain_ids : ctx.limits.allowed_chain_ids;
  const added = ctx.repos.db2.addContact({ name: check.name, address, chain_ids, ens_name: flow.ens?.name ?? null });
  if (!added.ok) {
    if (added.reason === 'name_taken') return again(st, q, REASK_HINT.NAME_TAKEN());
    return { kind: 'error', code: 'INTERNAL_ERROR' };
  }
  const rows = ctx.repos.db2.findByNameKey(nameKey(check.name));
  const source = flow.origin.untrusted ? 'untrusted' : flow.ens !== null ? 'ens' : 'user';
  return proceed(ctx, st, {
    k: 'resolved',
    r: {
      kind: 'single',
      display_name: check.name,
      address,
      ens_name: flow.ens?.name ?? null,
      source,
      is_contact: true,
      contact_chain_ids: rows.map((r) => r.chain_id),
      ens_chain_ids: flow.ens?.chain_ids ?? [],
      pinned_chain_id: flow.ens?.pinned ?? null,
    },
  });
}

async function answerEnsChain(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  flow: Extract<Flow, { t: 'ens_chain' }>,
): Promise<StepResult> {
  const chip = matchChip(q, answer);
  const picked = chip === null ? undefined : flow.found.find((f) => String(f.chain_id) === chip.id);
  if (picked === undefined) return again(st, q);
  // §9.3 step 6: the chosen chain pins this recipient.
  const chain_ids = flow.found.filter((f) => f.address === picked.address).map((f) => f.chain_id);
  return proceed(
    ctx,
    st,
    addressChecked(
      ctx,
      picked.address,
      flow.origin,
      { name: flow.name, chain_ids, pinned: picked.chain_id },
      flow.attempt,
    ),
  );
}

async function answerEnsChanged(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  flow: Extract<Flow, { t: 'ens_changed' }>,
): Promise<StepResult> {
  const chip = matchChip(q, answer);
  if (chip === null) return again(st, q);
  if (chip.id === CHIPS.CANCEL.id) {
    st.flow = null;
    st.pending = null;
    // SQ-15: request DISCARDED; reply per the interim answer (§13.3 "User cancelled").
    return { kind: 'discard', messages: [REPLY.CANCELLED()] };
  }
  if (chip.id === CHIPS.ENS_USE_NEW.id && flow.fresh !== null) {
    if (isSelf(flow.fresh, ctx.config.wallet.address))
      return proceed(ctx, st, stop({ kind: 'error', code: 'SELF_PAYMENT' }));
    const upd = ctx.repos.db2.updateAddressForName(flow.name_key, flow.fresh);
    // spec-questions/C.md SQ-C-03: the new address is already saved under another name (§7.1 invariant).
    if (!upd.ok) return proceed(ctx, st, unsupported(ctx, 'ens_new_address_saved_under_other_name'));
  }
  const rows = ctx.repos.db2.findByNameKey(flow.name_key);
  return proceed(ctx, st, { k: 'resolved', r: contactResolved(rows) });
}

async function answerGroup(
  ctx: StepContext,
  st: S6State,
  q: Question,
  answer: Answer,
  flow: Extract<Flow, { t: 'group' }>,
): Promise<StepResult> {
  if (flow.stage === 'parent') {
    const t = textOf(answer);
    const parent = t === null ? null : normalizeEns(t);
    if (parent === null) return again(st, q);
    // A parent that turns out not to be in ENS is asked again as a re-ask of this question.
    return proceed(ctx, st, await groupAdvance(ctx, { ...flow, parent, parent_attempt: q.attempt + 1 }));
  }
  if (flow.stage === 'chain') {
    const chip = matchChip(q, answer);
    if (chip === null) return again(st, q);
    return proceed(ctx, st, await groupAdvance(ctx, { ...flow, chain_id: Number(chip.id) as ChainId }));
  }
  if (answer.kind !== 'selected') return again(st, q);
  const enabled = new Set(q.chips.filter((c) => !c.disabled).map((c) => c.id));
  const picked = new Set(answer.selected_ids);
  // Selecting zero (or anything not offered) → re-ask (§9.6 step 9).
  if (picked.size === 0 || [...picked].some((id) => !enabled.has(id))) return again(st, q);
  return proceed(ctx, st, groupFinish(ctx, flow, picked));
}

async function answerNoPayee(ctx: StepContext, st: S6State, q: Question, answer: Answer): Promise<StepResult> {
  const t = textOf(answer);
  if (t === null || t.length === 0) return again(st, q);
  // Resolved via §9 like a typed payee.
  ctx.req.spans.push({
    text: t,
    kind: looksLikeAddress(t) ? 'address' : 'name',
    role: 'payee',
    span: null,
    source: 'user',
    followup_placeholder: null,
    untrusted_item_index: null,
  });
  st.flow = null;
  st.pending = null;
  return { kind: 'continue' };
}
