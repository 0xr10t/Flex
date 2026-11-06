import type { StepContext } from '../contracts/step.js';
import type { Payment } from '../contracts/types.js';
import { maskedToTyped, type S3State } from '../pipeline/s3-amounts.js';

/** G01: the global chain enum is necessary but does not bind a chain to its payment clause. */
export function chainBindingProblems(ctx: StepContext, payments: Payment[]): string[] {
  const { req } = ctx;
  const amountClause = (p: Payment): number | undefined =>
    req.amounts.find((a) => a.placeholder === p.amount)?.span?.clause_index;
  const recipientClause = (p: Payment): number | undefined => {
    const ref = req.recipients.find((r) => r.placeholder === p.recipient);
    return ref === undefined ? undefined : req.spans[ref.span_index]?.span?.clause_index;
  };
  const occupied = new Set(
    payments.flatMap((p) => [amountClause(p), recipientClause(p)]).filter((n) => n !== undefined),
  );
  const masks = (req.step_state.s3 as S3State | undefined)?.masks ?? [];
  const entitySpans = [
    ...req.amounts.flatMap((a) => (a.span ? [a.span] : [])),
    ...req.recipients.flatMap((r) => {
      const span = req.spans[r.span_index]?.span;
      return span ? [{ ...span, start: maskedToTyped(masks, span.start), end: maskedToTyped(masks, span.end) }] : [];
    }),
  ];
  const sentence = new Map<number, number>();
  let sn = 0;
  req.scan.clauses.forEach((clause, i) => {
    const prev = req.scan.clauses[i - 1];
    if (prev && /[.!?;\n]/.test(req.typed_text.slice(prev.end, clause.start))) sn++;
    sentence.set(clause.index, sn);
  });
  const globalFor = (ci: number) => {
    const entities = entitySpans.filter((span) => sentence.get(span.clause_index) === sentence.get(ci));
    const mentioned = req.scan.chains.filter((c) => sentence.get(c.clause_index) === sentence.get(ci));
    const distinct = [...new Set(mentioned.map((c) => c.chain_id))];
    // A single chain leading/trailing an entire sentence applies to all its payments. Offsets are typed-text
    // offsets throughout; S5 recipient ranges originally refer to the longer amount-masked message.
    return distinct.length === 1 &&
      entities.length > 0 &&
      mentioned.some(
        (c) => c.end <= Math.min(...entities.map((s) => s.start)) || c.start >= Math.max(...entities.map((s) => s.end)),
      )
      ? distinct
      : [];
  };
  const problems: string[] = [];
  payments.forEach((p, i) => {
    const own = new Set([amountClause(p), recipientClause(p)].filter((n) => n !== undefined));
    // A chain-only suffix ("send ... , on Base") belongs to the preceding payment.
    const scope = new Set(own);
    for (const ci of own) {
      for (
        let next = ci + 1;
        next < req.scan.clauses.length && !occupied.has(next) && sentence.get(next) === sentence.get(ci);
        next++
      )
        scope.add(next);
    }
    const local = [...new Set(req.scan.chains.filter((c) => scope.has(c.clause_index)).map((c) => c.chain_id))];
    const chains = local.length > 0 ? local : [...new Set([...own].flatMap(globalFor))];
    if (chains.length === 1 && p.chain !== chains[0]) {
      problems.push(
        `Payment ${i + 1}: its clause explicitly names chain ${chains[0]}; use that chain, not "unstated" or a different payment's chain.`,
      );
    } else if (chains.length > 1 && (p.chain === 'unstated' || !chains.includes(p.chain))) {
      problems.push(`Payment ${i + 1}: use a chain explicitly named in its own clause.`);
    }
  });
  return problems;
}
