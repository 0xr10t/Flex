// Acceptance tests that need no pipeline step: harness self-tests (session, auth, health, settings), A-53, A-54, A-55
// (reports), and the A-60 grep mechanism. These pass on the platform alone.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildPaymentsSchema, validators } from '../../src/schemas/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcceptanceLlm, ARADHYA, BASE, MIHIR, REPORT_TOKEN, UI_TOKEN, harness, scanLogs } from './harness.js';
import { planIdFor, DELEGATE, seedAutopay, seedSpend } from './seed.js';

const PERSISTENT = ['db2_address_book', 'db4_balances', 'db5_limits', 'db6_spend_log', 'db7_autopays'];
const SESSION = ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history', 'db8_sessions'];

export function registerPlatform(): void {
  describe('harness self-tests (platform only)', () => {
    it('harness: health, bearer auth and the settings API', async () => {
      const h = await harness('none');
      const health = await h.http('GET', '/v1/health');
      expect(health.json).toEqual({ ok: true, ollama: true, db: true });
      expect((await h.http('GET', '/v1/health', { token: null })).status).toBe(401);
      expect((await h.http('GET', '/v1/health', { token: REPORT_TOKEN })).status).toBe(401);
      expect(
        (await h.http('POST', '/v1/execution/reports', { token: UI_TOKEN, body: { kind: 'autopay_status' } })).status,
      ).toBe(401);

      const limits = (await h.http('GET', '/v1/settings/limits')).json;
      expect(limits.per_tx_max).toEqual({ USDC: '100', ETH: '0.05' });
      expect(limits.daily_max).toEqual({ USDC: '300', ETH: '0.15' });
      const put = await h.http('PUT', '/v1/settings/limits', {
        body: { ...limits, per_tx_max: { USDC: '150', ETH: '0.05' } },
      });
      expect(put.status).toBe(200);
      expect(h.repos.db5.getAll().per_tx_max.USDC).toBe('150');
      expect((await h.http('PUT', '/v1/settings/limits', { body: { ...limits, autopay_max_weeks: 0 } })).status).toBe(
        400,
      );
      await h.finish();
    });

    it('harness: open session, new session closes the previous one, close of an unknown id is 404', async () => {
      const h = await harness('none');
      expect((await h.http('POST', '/v1/sessions', { body: { timezone: 'Not/AZone' } })).status).toBe(400);
      const s1 = await h.open();
      expect(s1).toMatch(/^ses_[0-9a-f]{12}$/);
      expect(h.count('db8_sessions')).toBe(1);
      h.repos.db1.mint({
        session_id: s1,
        request_id: 'req_000000000001',
        amount: '5',
        token: 'USDC',
        source: 'user',
        origin: 'phrase',
        confirmed: true,
      });
      const s2 = await h.open();
      expect(s2).not.toBe(s1);
      expect(h.count('db1_amount_placeholders')).toBe(0);
      expect(h.count('db8_sessions')).toBe(1);
      expect((await h.http('DELETE', `/v1/sessions/${s1}`)).status).toBe(404);
      expect(await h.close()).toBe(204);
      expect(h.count('db8_sessions')).toBe(0);
      await h.finish();
    });
  });

  describe('fixtures', () => {
    it('harness: every recorded LLM fixture output is schema-valid (payments: after placeholder substitution) and uses real call names', () => {
      const dir = join(import.meta.dirname, '..', 'fixtures', 'llm');
      const byName = {
        amounts: validators.amounts,
        request_type: validators.requestType,
        spans: validators.recipientSpans,
        quarantine: validators.quarantine,
      } as const;
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(40);
      for (const f of files) {
        const fixture = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
          calls: Array<{ name: string; output: unknown }>;
        };
        for (const c of fixture.calls) {
          if (c.name === 'payments') {
            expect(JSON.stringify(c.output), f).toContain('"payments"');
            continue;
          }
          const v = byName[c.name as keyof typeof byName];
          expect(v(c.output), `${f} ${c.name}: ${JSON.stringify(v.errors)}`).toBe(true);
        }
      }
    });
  });

  describe('llm fixture client', () => {
    it('harness: "$amount:N" / "$recipient:N" references are resolved from the AMOUNTS / RECIPIENTS lists of the prompt, then schema-validated', async () => {
      const h = await harness('A-38');
      const user =
        'Message: <<<Send amount_aa11bb22 to address_0a0b0c0d>>>\nAMOUNTS: [{"placeholder":"amount_aa11bb22","token":"USDC","from_attached_content":false}]\n' +
        'RECIPIENTS: [{"placeholder":"address_0a0b0c0d","type":"person"},{"placeholder":"address_1e1f2a2b","type":"person"}]\nACTION KINDS: ["i"]';
      const llm = new AcceptanceLlm({
        calls: [
          {
            name: 'payments',
            match: 'ACTION KINDS:',
            output: {
              payments: [
                {
                  kind: 'i',
                  amount: '$amount:0',
                  recipient: '$recipient:1',
                  chain: 'unstated',
                  frequency: null,
                  interval: null,
                  times_per_week: null,
                  days_of_week: null,
                  day_of_month: null,
                },
              ],
            },
          },
        ],
      });
      const schema = buildPaymentsSchema({
        maxItems: 3,
        kinds: ['i'],
        amounts: ['amount_aa11bb22'],
        recipients: ['address_0a0b0c0d', 'address_1e1f2a2b'],
        chains: [84532],
      });
      const out = await llm.call<{ payments: Array<{ amount: string; recipient: string }> }>({
        name: 'payments',
        system: 's',
        user,
        schema,
      });
      expect(out.payments[0]).toMatchObject({ amount: 'amount_aa11bb22', recipient: 'address_1e1f2a2b' });
      expect(llm.remaining()).toEqual([]);
      await h.finish({ allowUnused: true });
    });
  });

  describe('platform acceptance rows', () => {
    it('A-53: session close empties DB1/DB3/DB8 and leaves DB2/DB4-DB7 unchanged', async () => {
      const h = await harness('none');
      const sid = await h.open();
      // Fill every table.
      h.repos.db1.mint({
        session_id: sid,
        request_id: 'req_000000000001',
        amount: '50',
        token: 'USDC',
        source: 'user',
        origin: 'phrase',
        confirmed: true,
      });
      h.repos.db3.mint({
        session_id: sid,
        request_id: 'req_000000000001',
        kind: 'single',
        name: 'Aradhya',
        address: ARADHYA,
        ens_name: null,
        chain_id: null,
        group_placeholder: null,
        source: 'contact',
      });
      h.repos.db8.insertPrompt({
        session_id: sid,
        request_id: 'req_000000000001',
        kind: 'typed',
        text: 'send 50 usdc to aradhya',
        created_at: h.nowIso,
      });
      h.repos.db8.appendHistory({
        session_id: sid,
        request_id: 'req_000000000001',
        payments_json: '[]',
        handed_off_at: h.nowIso,
      });
      h.repos.db4.upsertOk(
        { chain_id: BASE, chain: 'Base Sepolia', token: 'USDC', balance: '80', base_units: '80000000' },
        h.nowIso,
      );
      seedAutopay(h);
      seedSpend(h, { amount: '10', status: 'pending' });
      for (const t of SESSION) expect(h.count(t), t).toBeGreaterThan(0);
      const before = h.snapshot(PERSISTENT);

      expect(await h.close()).toBe(204);

      for (const t of [
        'db1_amount_placeholders',
        'db3_address_placeholders',
        'db8_prompts',
        'db8_history',
        'db8_sessions',
      ]) {
        expect(h.count(t), t).toBe(0);
      }
      expect(h.snapshot(PERSISTENT)).toBe(before);
      expect(h.count('db2_address_book')).toBe(5);
      await h.finish();
    });

    it('A-54: intent_result for a k step moves the DB7 row to active with the delegate and updates DB6', async () => {
      const h = await harness('none');
      const id = seedAutopay(h, { id: 'ap_aaaaaaaaaaaa', status: 'pending' });
      seedSpend(h, {
        request_id: 'req_00000000aaaa',
        step: 0,
        kind: 'autopay_prefund',
        counts_toward_limit: false,
        intent_id: 'k',
        autopay_id: id as `ap_${string}`,
        status: 'pending',
        amount: '80',
        tx_hash: null,
        executed_at: null,
      });
      const txHash = '0x' + 'cd'.repeat(32);
      const status = await h.report({
        kind: 'intent_result',
        request_id: 'req_00000000aaaa',
        step: 0,
        status: 'executed',
        tx_hash: txHash,
        executed_at: '2026-11-06T04:31:00Z',
        autopay: { autopay_id: id, plan_id: planIdFor(id), executor_address: DELEGATE, chain_id: BASE, token: 'USDC' },
      });
      expect(status).toBe(204);
      const row = h.repos.db7.get(id)!;
      expect(row.status).toBe('active');
      expect(row.executor_address).toBe(DELEGATE);
      expect(row.plan_id).toBe(planIdFor(id));
      const spend = h.rows<{ status: string; tx_hash: string; executed_at: string }>(
        "SELECT * FROM db6_spend_log WHERE kind='autopay_prefund'",
      );
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ status: 'executed', tx_hash: txHash });
      expect(Date.parse(spend[0]!.executed_at)).toBe(Date.parse('2026-11-06T04:31:00Z'));
      // Unknown request id -> 404, malformed -> 400.
      expect(
        await h.report({
          kind: 'intent_result',
          request_id: 'req_ffffffffffff',
          step: 0,
          status: 'executed',
          tx_hash: txHash,
          executed_at: '2026-11-06T04:31:00Z',
        }),
      ).toBe(404);
      expect(await h.report({ kind: 'nonsense' } as never)).toBe(400);
      await h.finish();
    });

    it("A-55: autopay_payment inserts a DB6 row that counts toward today's limit", async () => {
      const h = await harness('none');
      const id = seedAutopay(h);
      const status = await h.report({
        kind: 'autopay_payment',
        request_id: 'req_00000000aaaa',
        status: 'executed',
        tx_hash: '0x' + 'ef'.repeat(32),
        executed_at: '2026-11-05T17:00:00Z',
        autopay: {
          autopay_id: id,
          plan_id: planIdFor(id),
          executor_address: DELEGATE,
          slot: 0,
          status: 'active',
          amount: '10',
          fee: '0.05',
          chain_id: BASE,
          token: 'USDC',
        },
      });
      expect(status).toBe(204);
      const rows = h.rows<Record<string, unknown>>("SELECT * FROM db6_spend_log WHERE kind='autopay_payment'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'executed',
        counts_toward_limit: 1,
        amount: '10',
        chain_id: BASE,
        token: 'USDC',
        autopay_id: id,
        step: null,
      });
      const today = h.repos.db6.spentToday('USDC', 'Asia/Kolkata', h.nowIso);
      expect(today.map((r) => r.amount)).toEqual(['10', '0.05']);
      // The same row is not "today" on another day.
      expect(h.repos.db6.spentToday('USDC', 'Asia/Kolkata', '2026-11-07T10:00:00Z')).toEqual([]);
      await h.finish();
    });

    it('A-55: autopay_status ends the DB7 row', async () => {
      const h = await harness('none');
      const id = seedAutopay(h);
      expect(
        await h.report({
          kind: 'autopay_status',
          request_id: 'req_00000000aaaa',
          autopay: {
            autopay_id: id,
            plan_id: planIdFor(id),
            executor_address: DELEGATE,
            chain_id: BASE,
            token: 'USDC',
            status: 'ended',
          },
        }),
      ).toBe(204);
      expect(h.repos.db7.get(id)!.status).toBe('ended');
      expect(
        await h.report({
          kind: 'autopay_status',
          request_id: 'req_00000000aaaa',
          autopay: {
            autopay_id: 'ap_ffffffffffff',
            plan_id: planIdFor(id),
            executor_address: DELEGATE,
            chain_id: BASE,
            token: 'USDC',
            status: 'ended',
          },
        }),
      ).toBe(404);
      await h.finish();
    });
  });

  describe('A-60 grep mechanism', () => {
    it('A-60: the log scanner flags planted sensitive values and non-allowlisted fields, and passes clean logs', () => {
      const dir = mkdtempSync(join(tmpdir(), 'scan-selftest-'));
      writeFileSync(
        join(dir, 'a.log'),
        '{"level":"info","ts":"2026-11-05T10:00:00.000Z","event":"step_done","step":"s3","duration_ms":50}\n',
      );
      const values: Array<[string, 'address' | 'name' | 'ens' | 'prompt' | 'amount']> = [
        [ARADHYA, 'address'],
        [MIHIR, 'address'],
        ['aradhya', 'name'],
        ['riya.eth', 'ens'],
        ['send 50 usdc', 'prompt'],
        ['50', 'amount'],
      ];
      expect(scanLogs(dir, values)).toEqual({ lines: 1, hits: [] });
      writeFileSync(
        join(dir, 'b.log'),
        `{"level":"info","ts":"x","event":"x","note":"Sent to Aradhya ${ARADHYA} riya.eth"}\n{"level":"info","ts":"x","event":"50"}\n`,
      );
      const { hits } = scanLogs(dir, values);
      expect(hits.map((x) => x.kind).sort()).toEqual(['address', 'amount', 'ens', 'field', 'name'].sort());
    });
  });
}
