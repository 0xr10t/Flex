import type { StepContext } from '../contracts/step.js';
import type { Payment } from '../contracts/types.js';

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
  const entitySpans = [
    ...req.amounts.flatMap((a) => (a.span ? [a.span] : [])),
    ...req.recipients.flatMap((r) => (req.spans[r.span_index]?.span ? [req.spans[r.span_index]!.span!] : [])),
  ];
  const distinct = [...new Set(req.scan.chains.map((c) => c.chain_id))];
  // A single chain before every payment or at the end of the whole request applies to every payment.
  const global =
    distinct.length === 1 &&
    entitySpans.length > 0 &&
    req.scan.chains.some(
      (c) =>
        c.end <= Math.min(...entitySpans.map((s) => s.start)) || c.start >= Math.max(...entitySpans.map((s) => s.end)),
    )
      ? distinct
      : [];
  const problems: string[] = [];
  payments.forEach((p, i) => {
    const own = new Set([amountClause(p), recipientClause(p)].filter((n) => n !== undefined));
    // A chain-only suffix ("send ... , on Base") belongs to the preceding payment.
    const scope = new Set(own);
    for (const ci of own) {
      for (let next = ci + 1; next < req.scan.clauses.length && !occupied.has(next); next++) scope.add(next);
    }
    const local = [...new Set(req.scan.chains.filter((c) => scope.has(c.clause_index)).map((c) => c.chain_id))];
    const chains = local.length > 0 ? local : global;
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
