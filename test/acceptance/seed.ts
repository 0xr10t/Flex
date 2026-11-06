// Seeding and expectation builders shared by the acceptance tests.
import type { Db6Insert } from '../../src/contracts/repos.js';
import type { ChainId, Token } from '../../src/contracts/types.js';
import { BASE, MIHIR, type Harness } from './harness.js';

export const DELEGATE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const; // valid EIP-55 test address

export function weeklySchedule(
  days: string[],
  first = '2026-11-06T04:30:00Z',
  end: unknown = { type: 'until_cancelled' },
) {
  return {
    frequency: 'weekly',
    interval: 1,
    days_of_week: days,
    day_of_month: null,
    time_of_day: '10:00',
    timezone: 'Asia/Kolkata',
    start_date: first.slice(0, 10),
    first_occurrence: first,
    end,
  };
}

/** A DB7 autopay row for Mihir, `active` with a delegate (E7 setup). */
export function seedAutopay(
  h: Harness,
  o: {
    id?: string;
    amount?: string;
    chain?: ChainId;
    status?: 'pending' | 'active';
    schedule?: unknown;
    name?: string;
    address?: `0x${string}`;
    token?: Token;
  } = {},
): string {
  const id = o.id ?? 'ap_0123456789ab';
  h.repos.db7.insertPending(
    {
      autopay_id: id as `ap_${string}`,
      request_id: 'req_00000000aaaa',
      recipient_name: o.name ?? 'Mihir',
      recipient_address: o.address ?? MIHIR,
      chain_id: o.chain ?? BASE,
      token: o.token ?? 'USDC',
      amount_per_payment: o.amount ?? '10',
      schedule_json: JSON.stringify(o.schedule ?? weeklySchedule(['FRI'])),
    },
    h.nowIso,
  );
  if ((o.status ?? 'active') === 'active') {
    h.repos.db7.update(id, { status: 'active', delegate_address: DELEGATE, cre_job_id: 'cre-job-1' }, h.nowIso);
  }
  return id;
}

export function seedSpend(h: Harness, row: Partial<Db6Insert> & { amount: string }): void {
  h.repos.db6.insertMany([
    {
      request_id: 'req_00000000bbbb',
      step: 0,
      kind: 'payment',
      counts_toward_limit: true,
      chain_id: BASE,
      token: 'USDC',
      recipient_address: MIHIR,
      intent_id: 'i',
      autopay_id: null,
      status: 'executed',
      tx_hash: '0x' + 'ab'.repeat(32),
      created_at: h.nowIso,
      executed_at: h.nowIso,
      ...row,
    },
  ]);
}
