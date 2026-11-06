// Implements: §13.1 summary line templates, {cadence} and {end text} forms; §13.2 balance answer lines;
// §10.7 step 3 Q_AUTOPAY_PICK chip label. Verbatim from the spec.
// Home of these texts per §21 (`src/messages/`: summary, balance answer, question and error texts); CCR D-1 rejected.
// SQ-CHAT-02: exact, self-labelled wallet facts selected by the conversational model.

type P = Record<string, string>;

function req(p: P, key: string): string {
  const v = p[key];
  if (v === undefined) throw new Error(`templates: missing param ${key}`);
  return v;
}

/** §13.1 line templates, one per intent. */
export const SUMMARY_LINE = {
  J: (p: P) =>
    `Move ${req(p, 'padded')} ${req(p, 'token')} from ${req(p, 'source')} to ${req(p, 'dest')} (your own account; includes a ${req(p, 'b')}% fee buffer, anything left over stays with you).`,
  I: (p: P) =>
    `Send ${req(p, 'amount')} ${req(p, 'token')} to ${req(p, 'name')} (${req(p, 'addr')}) on ${req(p, 'chain')}.`,
  /** Appended to an `i` line when `depends_on` is non-empty (SQ-D-03: several steps are joined with " and "). */
  AFTER_STEP: (p: P) => ` After step ${req(p, 'n')}.`,
  /** SQ-D-02: the template has no final period; the §19 E4 example ends with one. */
  I_GROUP: (p: P) =>
    `Send ${req(p, 'amount')} ${req(p, 'token')} each to ${req(p, 'count')} members of ${req(p, 'parent')} on ${req(p, 'chain')}: ${req(p, 'names')}.`,
  K: (p: P) =>
    `Pay ${req(p, 'name')} (${req(p, 'addr')}) ${req(p, 'amount')} ${req(p, 'token')} ${req(p, 'cadence')} at ${req(p, 'time')} (${req(p, 'timezone')}) on ${req(p, 'chain')}, first on ${req(p, 'first')}, ${req(p, 'end')}. Sets aside ${req(p, 'total_cap')} ${req(p, 'token')} now; anything unused is refunded if you cancel.`,
  L: (p: P) =>
    `Stop paying ${req(p, 'name')} ${req(p, 'amount')} ${req(p, 'token')} ${req(p, 'cadence')} on ${req(p, 'chain')}, and refund what's left in it to you.`,
} as const;

/** §13.1 {cadence}. `days` already joined ("Mon and Thu"), `d` already an ordinal ("28th", SQ-D-04). */
export const CADENCE = {
  DAILY: () => 'every day',
  DAILY_N: (p: P) => `every ${req(p, 'n')} days`,
  WEEKLY: (p: P) => `every ${req(p, 'days')}`,
  WEEKLY_N: (p: P) => `every ${req(p, 'n')} weeks on ${req(p, 'days')}`,
  MONTHLY: (p: P) => `on the ${req(p, 'd')} of every month`,
  MONTHLY_N: (p: P) => `every ${req(p, 'n')} months on the ${req(p, 'd')}`,
} as const;

/** §13.1 {end text}. */
export const END_TEXT = {
  COUNT: (p: P) => `for ${req(p, 'n')} payments`,
  DATE: (p: P) => `until ${req(p, 'date')}`,
  CANCEL: (p: P) => `until you cancel (at most ${req(p, 'weeks')} weeks)`,
} as const;

/** §10.7 step 3 chip label, e.g. "10 USDC weekly on MON, Base Sepolia, since 2026-11-10" (SQ-D-05). */
export const AUTOPAY_PICK_LABEL = (p: P): string =>
  `${req(p, 'amount')} ${req(p, 'token')} ${req(p, 'schedule')}, ${req(p, 'chain')}, since ${req(p, 'since')}`;

/** §13.2 balance answer. */
export const BALANCE = {
  HEADER: () => 'Your balances:',
  /** First chain line with a readable balance (§13.2 example line 1). */
  CHAIN_FIRST: (p: P) =>
    `- ${req(p, 'chain')}: ${req(p, 'eth')} ETH (${req(p, 'eth_spendable')} spendable after the gas reserve), ${req(p, 'usdc')} USDC`,
  CHAIN: (p: P) =>
    `- ${req(p, 'chain')}: ${req(p, 'eth')} ETH (${req(p, 'eth_spendable')} spendable), ${req(p, 'usdc')} USDC`,
  CHAIN_UNREADABLE: (p: P) => `- ${req(p, 'chain')}: couldn't be read right now`,
  TOTAL: (p: P) => `Total: ${req(p, 'eth')} ETH, ${req(p, 'usdc')} USDC`,
} as const;

/** SQ-CHAT-02: model-selected facts keep their verified values and meaning together. */
export const WALLET_FACT = {
  ADDRESS: (p: P) => `Your wallet address is ${req(p, 'address')}.`,
  BALANCE: (p: P) => `${req(p, 'chain')}: ${req(p, 'amount')} ${req(p, 'token')} balance.`,
  SPENDABLE: (p: P) =>
    `${req(p, 'chain')}: ${req(p, 'amount')} ${req(p, 'token')} available to send after pending spending and any gas reserve.`,
  PENDING: (p: P) => `${req(p, 'chain')}: ${req(p, 'amount')} ${req(p, 'token')} reserved for pending spending.`,
  GAS_RESERVE: (p: P) => `${req(p, 'chain')}: ${req(p, 'amount')} ETH kept for gas.`,
  UNAVAILABLE: (p: P) => `Balances on ${req(p, 'chain')} could not be read right now.`,
  ALL_UNAVAILABLE: () => 'Your balances could not be read right now; no current balance is available.',
  TOTAL: (p: P) => `Total balance across your allowed test networks: ${req(p, 'amount')} ${req(p, 'token')}.`,
  SUBTOTAL: (p: P) =>
    `Balance subtotal on readable test networks: ${req(p, 'amount')} ${req(p, 'token')}. Other networks are unavailable, so this is not a complete total.`,
  TOTAL_SPENDABLE: (p: P) =>
    `Available to send across your allowed test networks: ${req(p, 'amount')} ${req(p, 'token')}, before any transfer-specific fees or limits.`,
  SUBTOTAL_SPENDABLE: (p: P) =>
    `Available to send on readable test networks: ${req(p, 'amount')} ${req(p, 'token')}, before any transfer-specific fees or limits. Other networks are unavailable.`,
} as const;
