// A-33 … A-52 (spec §20.2): lexical errors, amount rules, content errors, RPC failures, confirmation flows.
import { describe, expect, it } from 'vitest';
import {
  expectEnvelope,
  expectError,
  expectHandedOff,
  lastHistory,
  noSubmission,
  pending,
  spend,
  usdcIntent,
} from './checks.js';
import {
  ARADHYA,
  ARB,
  BASE,
  MIHIR,
  SEPOLIA,
  USDC_ADDR,
  WALLET,
  addr,
  eth,
  harness,
  lines,
  registerSensitive,
  usdc,
} from './harness.js';

export function registerA33toA52(): void {
  describe('A-33 … A-52', () => {
    // S2 errors stop the request before any model call.
    it('A-33: "send 10 usdc on polygon to mihir" -> UNSUPPORTED_CHAIN (row wins over the §6.2 mainnet list; SQB-03)', async () => {
      const h = await harness('none');
      const r = await h.say('send 10 usdc on polygon to mihir');
      expectError(r, 'UNSUPPORTED_CHAIN', "I can't use polygon. I support Sepolia, Base Sepolia and Arbitrum Sepolia.");
      expect(h.llm.recorded).toEqual([]);
      await h.finish();
    });

    it('A-34: "send 10 usdc on base mainnet" -> MAINNET_NOT_SUPPORTED', async () => {
      const h = await harness('none');
      const r = await h.say('send 10 usdc on base mainnet');
      expectError(
        r,
        'MAINNET_NOT_SUPPORTED',
        'I only work on test networks for now: Sepolia, Base Sepolia and Arbitrum Sepolia.',
      );
      expect(h.llm.recorded).toEqual([]);
      await h.finish();
    });

    it('A-35: "send 10 dai to mihir" -> UNSUPPORTED_TOKEN', async () => {
      const h = await harness('none');
      const r = await h.say('send 10 dai to mihir');
      expectError(r, 'UNSUPPORTED_TOKEN', 'I can only send USDC and ETH.');
      expect(h.llm.recorded).toEqual([]);
      await h.finish();
    });

    it('A-36: "send fifty bucks to mihir" -> 50 USDC with the note "You wrote \'fifty bucks\' → 50 USDC"', async () => {
      const h = await harness('A-36');
      const r = await h.say('send fifty bucks to mihir');
      expect(h.asked).toEqual([]);
      expect(lines(r)).toEqual(['Send 50 USDC to Mihir (0x91Ab…77d0) on Base Sepolia.']);
      expect(r.body.summary?.notes).toEqual(["You wrote 'fifty bucks' → 50 USDC."]);
      expectHandedOff(await h.confirm(r, 'yes'));
      expectEnvelope(h, r.body.request_id, [
        usdcIntent({ step: 0, chain: BASE, token_address: USDC_ADDR[BASE], amount: usdc('50'), recipient: MIHIR }),
      ]);
      await h.finish();
    });

    it('A-37: "send ₹500 to mihir" -> Q_FIAT_OTHER', async () => {
      const h = await harness('A-37');
      const r1 = await h.say('send ₹500 to mihir');
      expect(r1.body.question?.code).toBe('Q_FIAT_OTHER');
      expect(r1.body.question?.text).toBe("I can't convert ₹500. How much in USDC or ETH?");
      // SQ-09 (OPEN): number input, the token is asked afterwards with Q_TOKEN.
      expect(r1.body.question?.input).toBe('number');
      const r2 = await h.answer(r1, { text: '10' });
      expect(r2.body.question?.code).toBe('Q_TOKEN');
      const r3 = await h.answer(r2, { chipLabel: 'USDC' });
      expect(r3.body.state).toBe('awaiting_confirmation');
      expect(lines(r3)).toEqual(['Send 10 USDC to Mihir (0x91Ab…77d0) on Base Sepolia.']);
      await h.finish();
    });

    it('A-38: "send 10 each to aradhya and mihir" -> two i sharing one amount placeholder', async () => {
      const h = await harness('A-38');
      const r1 = await h.say('send 10 each to aradhya and mihir');
      expect(r1.body.question?.code).toBe('Q_TOKEN'); // no token word in the message (§8.4 rule (e))
      const r = await h.answer(r1, { chipLabel: 'USDC' });
      expect(lines(r)).toEqual([
        'Send 10 USDC to Aradhya (0x3fA9…c21E) and 10 USDC to Mihir (0x91Ab…77d0) on Base Sepolia in one atomic payment.',
      ]);
      expect(r.body.summary?.footer).toEqual(['Spent today after this: 20 of 300 USDC.']);
      expect(h.rows('SELECT amount FROM db1_amount_placeholders')).toEqual([{ amount: '10' }]); // one placeholder
      expectHandedOff(await h.confirm(r, 'yes'));
      const hist = lastHistory(h);
      expect(hist).toHaveLength(2);
      expect(hist[0]!.amount).toBe(hist[1]!.amount);
      expect(hist[0]!.recipient).not.toBe(hist[1]!.recipient);
      expectEnvelope(h, r.body.request_id, [
        { ...usdcIntent({ step: 0, chain: BASE, token_address: USDC_ADDR[BASE], amount: usdc('10'), recipient: ARADHYA }), recipients: [{ recipient: ARADHYA, amount: usdc('10') }, { recipient: MIHIR, amount: usdc('10') }] },
      ]);
      await h.finish();
    });

    it('A-39: "split 30 between aradhya and mihir" -> SPLIT_UNSUPPORTED', async () => {
      const h = await harness('A-39');
      const r1 = await h.say('split 30 between aradhya and mihir');
      expect(r1.body.question?.code).toBe('Q_TOKEN');
      const r = await h.answer(r1, { chipLabel: 'USDC' });
      expectError(r, 'SPLIT_UNSUPPORTED', 'Tell me how much each person should get, e.g. "15 to A and 15 to B".');
      expect(h.llm.names()).toEqual(['amounts', 'request_type', 'spans']); // decided after S5, before pairing
      noSubmission(h);
      await h.finish();
    });

    it('A-40: "send half my eth to mihir" -> relative amount, chain pinned, note', async () => {
      const h = await harness('A-40');
      const r = await h.say('send half my eth to mihir');
      expect(h.asked).toEqual([]);
      // ETH spendable: Sepolia 0.09, Base 0.098, Arbitrum 0.098 -> Base (first of the tie); half = 0.049.
      expect(lines(r)).toEqual(['Send 0.049 ETH to Mihir (0x91Ab…77d0) on Base Sepolia.']);
      expect(r.body.summary?.notes).toEqual(["You wrote 'half my eth' → 0.049 ETH."]);
      expect(r.body.summary?.footer).toEqual(['Spent today after this: 0.049 of 0.15 ETH.']);
      expect(h.rows<{ origin: string }>('SELECT origin FROM db1_amount_placeholders')).toEqual([
        { origin: 'relative' },
      ]);
      expectHandedOff(await h.confirm(r, 'yes'));
      expectEnvelope(h, r.body.request_id, [
        {
intent_id: 'i',
step: 0,
depends_on: [],
token: 'ETH',
token_address: null,
chain_id: BASE,
recipients: [{ amount: eth('0.049'), recipient: MIHIR }]
},
      ]);
      await h.finish();
    });

    it('A-41: "send all my usdc to everyone under iitr.eth" -> RELATIVE_AMOUNT_NOT_ALLOWED', async () => {
      const h = await harness('A-41');
      const names = ['alice.iitr.eth', 'bob.iitr.eth'];
      h.subnames.children.set('iitr.eth', names);
      names.forEach((n, i) => h.ens.set(n, 0x80000000n | BigInt(BASE), addr(0xb1 + i)));
      const r1 = await h.say('send all my usdc to everyone under iitr.eth');
      expect(r1.body.question?.code).toBe('Q_GROUP_CHAIN');
      const r2 = await h.answer(r1, { chipLabel: 'Base Sepolia' });
      expect(r2.body.question?.code).toBe('Q_GROUP_MEMBERS');
      const r = await h.answer(r2, { selectedLabels: names });
      expectError(
        r,
        'RELATIVE_AMOUNT_NOT_ALLOWED',
        "I can use 'all' or 'half' only for a one-time payment to one person.",
      );
      noSubmission(h);
      await h.finish();
    });

    it('A-42: "send 10 usdc to aradhya at 5pm" -> 5 is a chrono span, not an amount (no Q_AMOUNT_UNCOVERED)', async () => {
      const h = await harness('A-42');
      const r = await h.say('send 10 usdc to aradhya at 5pm');
      expect(h.asked).toEqual([]);
      expect(r.body.state).toBe('awaiting_confirmation');
      expect(lines(r)).toEqual(['Send 10 USDC to Aradhya (0x3fA9…c21E) on Base Sepolia.']);
      await h.finish();
    });

    it('A-43: "send 0.1234567 usdc to mihir" -> Q_AMOUNT_PRECISION', async () => {
      const h = await harness('A-43');
      const r1 = await h.say('send 0.1234567 usdc to mihir');
      expect(r1.body.question?.code).toBe('Q_AMOUNT_PRECISION');
      expect(r1.body.question?.text).toBe('USDC supports up to 6 decimal places. How much exactly?');
      expect(r1.body.question?.input).toBe('number');
      const r2 = await h.answer(r1, { text: '0.123456' });
      expect(lines(r2)).toEqual(['Send 0.123456 USDC to Mihir (0x91Ab…77d0) on Base Sepolia.']);
      expectHandedOff(await h.confirm(r2, 'yes'));
      expect((h.envelope.intents[0] as { recipients: { amount: unknown }[] }).recipients[0]!.amount).toEqual(usdc('0.123456'));
      await h.finish();
    });

    it('A-44: "send 10 usdc to <own address>" -> SELF_PAYMENT', async () => {
      const h = await harness('A-44');
      registerSensitive('address', WALLET);
      const r = await h.say(`send 10 usdc to ${WALLET}`);
      expectError(
        r,
        'SELF_PAYMENT',
        "That's your own address. Moving funds between your own chains isn't a payment I can make.",
      );
      noSubmission(h);
      await h.finish();
    });

    it('A-44: "send 10 usdc to me" never produces a payment (row says SELF_PAYMENT; §8.6 rule 2 drops "me", leaving Q_NO_PAYEE)', async () => {
      const h = await harness('A-44-me');
      const r = await h.say('send 10 usdc to me');
      // The spec is ambiguous here; either way nothing may be handed off.
      const code = r.body.question?.code ?? r.body.error?.code;
      expect(['Q_NO_PAYEE', 'SELF_PAYMENT']).toContain(code);
      noSubmission(h);
      await h.finish();
    });

    it('A-45: image attachment -> ATTACHMENT_UNSUPPORTED', async () => {
      const h = await harness('none');
      const r = await h.say('pay this', {
        attachments: [{ filename: 'receipt.png', mime: 'image/png', base64: 'iVBORw0KGgo=' }],
      });
      expectError(
        r,
        'ATTACHMENT_UNSUPPORTED',
        "I can only read text and PDF files. receipt.png wasn't read, so nothing was done.",
      );
      expect(h.llm.recorded).toEqual([]);
      expect(h.count('db8_prompts')).toBe(0);
      await h.finish();
    });

    it('A-46: http:// link -> URL_FETCH_FAILED', async () => {
      const h = await harness('none');
      const r = await h.say('pay the invoice here', { urls: ['http://example.com/invoice'] });
      expectError(r, 'URL_FETCH_FAILED', "I couldn't open link 1, so nothing was done.");
      expect(h.fetcher.calls).toEqual([]);
      expect(h.llm.recorded).toEqual([]);
      await h.finish();
    });

    it("A-47: one chain's RPC down -> chain excluded with a note; still plans on the others", async () => {
      const h = await harness('A-47');
      h.rpc.down.add(ARB);
      await h.refreshBalances();
      const r = await h.say('Send 50 USDc to ARADHYA');
      expect(r.body.state).toBe('awaiting_confirmation');
      expect(lines(r)).toEqual(['Send 50 USDC to Aradhya (0x3fA9…c21E) on Base Sepolia.']);
      expect(r.body.summary?.notes).toEqual([
        "Arbitrum Sepolia balance couldn't be read right now, so it wasn't used.",
      ]);
      const db4 = h.rows<{ chain_id: number; status: string }>(
        'SELECT chain_id, status FROM db4_balances ORDER BY chain_id, token',
      );
      expect(db4.filter((x) => x.chain_id === ARB).every((x) => x.status === 'unavailable')).toBe(true);
      expect(db4.filter((x) => x.chain_id !== ARB).every((x) => x.status === 'ok')).toBe(true);
      expectHandedOff(await h.confirm(r, 'yes'));
      expectEnvelope(h, r.body.request_id, [
        usdcIntent({ step: 0, chain: BASE, token_address: USDC_ADDR[BASE], amount: usdc('50'), recipient: ARADHYA }),
      ]);
      await h.finish();
    });

    it('A-48: all RPCs down -> BALANCES_UNAVAILABLE', async () => {
      const h = await harness('none');
      [SEPOLIA, BASE, ARB].forEach((c) => h.rpc.down.add(c));
      await h.refreshBalances();
      const r = await h.say('Send 50 USDc to ARADHYA');
      expectError(
        r,
        'BALANCES_UNAVAILABLE',
        "I can't read your balances on Sepolia, Base Sepolia and Arbitrum Sepolia right now. Try again in a moment.",
      );
      expect(h.llm.recorded).toEqual([]);
      await h.finish();
    });

    it('A-49: summary -> "no" -> DISCARDED; not in history', async () => {
      const h = await harness('A-49');
      const r = await h.say('Send 50 USDc to ARADHYA');
      const no = await h.confirm(r, 'no');
      expect(no.body.state).toBe('done');
      expect(no.body.messages.map((m) => m.text)).toEqual(["OK, I've dropped that. Tell me what you'd like instead."]);
      noSubmission(h);
      expect(h.count('db8_history')).toBe(0);
      expect(spend(h)).toEqual([]);
      // A second confirm on the discarded request is rejected.
      expect(
        (
          await h.http('POST', `/v1/sessions/${h.sessionId}/confirm`, {
            body: { request_id: r.body.request_id, decision: 'yes' },
          })
        ).status,
      ).toBe(409);
      await h.finish();
    });

    it('A-50: summary -> new unrelated message -> old discarded, new request starts', async () => {
      const h = await harness('A-50');
      const r1 = await h.say('Send 50 USDc to ARADHYA');
      const r2 = await h.say("what's my balance");
      expect(r2.body.request_id).not.toBe(r1.body.request_id);
      expect(r2.body.state).toBe('done');
      expect(r2.body.messages[0]!.text).toBe('I dropped the previous plan and started on your new request.');
      expect(r2.body.messages[1]!.text.startsWith('Your balances:')).toBe(true);
      expect(
        (
          await h.http('POST', `/v1/sessions/${h.sessionId}/confirm`, {
            body: { request_id: r1.body.request_id, decision: 'yes' },
          })
        ).status,
      ).toBe(409);
      noSubmission(h);
      expect(h.count('db8_history')).toBe(0);
      await h.finish();
    });

    it('A-51: execution 503 then confirm again -> same idempotency key; success on retry', async () => {
      const h = await harness('A-51');
      h.exec.responses = [{ status: 'unavailable', cause: 'server_error' }];
      const r = await h.say('Send 50 USDc to ARADHYA');
      const fail = await h.confirm(r, 'yes');
      expectError(fail, 'EXECUTION_UNAVAILABLE', "I couldn't reach your wallet. Confirm again to retry.");
      expect(spend(h)).toEqual([pending('payment', BASE, '50', 0, 'i', { recipient: ARADHYA })]);
      expect(h.repos.handoffs.get(r.body.request_id)?.status).toBe('submitted');
      expect(h.count('db8_history')).toBe(0);
      const ok = await h.confirm(r, 'yes');
      expectHandedOff(ok);
      expect(h.exec.submissions).toHaveLength(2);
      expect(h.exec.submissions[1]!.idempotencyKey).toBe(h.exec.submissions[0]!.idempotencyKey);
      expect(h.exec.submissions[0]!.idempotencyKey).toBe(r.body.request_id);
      expect(h.exec.submissions[1]!.envelope).toEqual(h.exec.submissions[0]!.envelope); // same envelope
      expect(spend(h)).toEqual([pending('payment', BASE, '50', 0, 'i', { recipient: ARADHYA })]);
      expect(h.count('db8_history')).toBe(1);
      await h.finish();
    });

    it("A-52: execution 400 -> EXECUTION_REJECTED with the execution layer's message", async () => {
      const h = await harness('A-52');
      h.exec.responses = [{ status: 'rejected', message: 'recipient is blocked' }];
      const r = await h.say('Send 50 USDc to ARADHYA');
      const fail = await h.confirm(r, 'yes');
      expectError(fail, 'EXECUTION_REJECTED', "Your wallet couldn't accept this: recipient is blocked");
      expect(spend(h)).toEqual([
        { ...pending('payment', BASE, '50', 0, 'i', { recipient: ARADHYA }), status: 'failed' },
      ]);
      expect(h.repos.db6.pendingRecent(BASE, 'USDC', h.nowIso)).toEqual([]);
      expect(h.repos.handoffs.get(r.body.request_id)).toMatchObject({ status: 'rejected', history: null });
      expect(h.count('db7_autopays')).toBe(0);
      expect(h.count('db8_history')).toBe(0);
      // FAILED, not retryable.
      expect(
        (
          await h.http('POST', `/v1/sessions/${h.sessionId}/confirm`, {
            body: { request_id: r.body.request_id, decision: 'yes' },
          })
        ).status,
      ).toBe(409);
      expect(h.exec.submissions).toHaveLength(1);
      await h.finish();
    });
  });
}
