// A-17 … A-32 (spec §20.2): balance, refusals, recipient resolution, ENS, limits, funding.
import { describe, expect, it } from 'vitest';
import { expectEnvelope, expectError, expectHandedOff, noSubmission, spend, usdcIntent } from './checks.js';
import {
  ARADHYA,
  ARB,
  BASE,
  SEPOLIA,
  USDC_ADDR,
  addr,
  coinType,
  harness,
  lines,
  registerSensitive,
  short,
  usdc,
  type Harness,
} from './harness.js';
import { seedSpend } from './seed.js';

const NEW1 = `0x${'5'.repeat(40)}` as const;
const NEW2 = `0x${'6'.repeat(40)}` as const;
const ENS1 = addr(0xe1);
const ENS2 = addr(0xe2);

function ensAllChains(h: Harness, name: string, a: `0x${string}`): void {
  h.ens.set(name, coinType(SEPOLIA), a).set(name, coinType(BASE), a).set(name, coinType(ARB), a);
}

export function registerA17toA32(): void {
  describe('A-17 … A-32', () => {
    it('A-17: "what\'s my balance" -> balance answer, no intents', async () => {
      const h = await harness('A-17');
      const r = await h.say("what's my balance");
      expect(r.body.state).toBe('done');
      expect(h.llm.names()).toEqual(['amounts', 'request_type']);
      expect(r.body.summary).toBeUndefined();
      expect(r.body.messages).toHaveLength(1);
      // §13.2, allowed_chain_ids order; spendable = balance minus the gas reserve (§10.1).
      const t = r.body.messages[0]!.text.split('\n');
      expect(t[0]).toBe('Your balances:');
      expect(t[1]).toMatch(/^- Sepolia: 0\.1 ETH \(0\.09 spendable.*\), 0 USDC$/);
      expect(t[2]).toMatch(/^- Base Sepolia: 0\.1 ETH \(0\.098 spendable.*\), 80 USDC$/);
      expect(t[3]).toMatch(/^- Arbitrum Sepolia: 0\.1 ETH \(0\.098 spendable.*\), 60 USDC$/);
      expect(t[4]).toBe('Total: 0.3 ETH, 140 USDC');
      expect(t).toHaveLength(5);
      noSubmission(h);
      expect(spend(h)).toEqual([]);
      await h.finish();
    });

    it('A-18: "swap my eth for usdc" -> UNSUPPORTED_REQUEST', async () => {
      const h = await harness('A-18');
      const r = await h.say('swap my eth for usdc');
      // SQ-01 (OPEN): the interim wording is the §15 text.
      expectError(
        r,
        'UNSUPPORTED_REQUEST',
        "I can send USDC or ETH, bridge funds between chains when a payment needs it, set up or stop repeating payments, and show balances. I can't help with that part.",
      );
      noSubmission(h);
      await h.finish();
    });

    it('A-19: "send 10 usdc to aradhya and swap eth" -> UNSUPPORTED_REQUEST (nothing is sent)', async () => {
      const h = await harness('A-19');
      const r = await h.say('send 10 usdc to aradhya and swap eth');
      expectError(r, 'UNSUPPORTED_REQUEST');
      expect(h.llm.names()).toEqual(['amounts', 'request_type']);
      noSubmission(h);
      expect(spend(h)).toEqual([]);
      await h.finish();
    });

    it('A-20: "send 10 usdc to riya" (unknown) -> Q_WHO_IS with close-contact chips; no alias saved', async () => {
      const h = await harness('A-20');
      h.addContact('Priya', addr(0xc1), [BASE]);
      h.addContact('Diya', addr(0xc2), [BASE]);
      h.addContact('Riyan', addr(0xc3), [BASE]);
      const r1 = await h.say('send 10 usdc to riya');
      expect(r1.body.question?.code).toBe('Q_WHO_IS');
      expect(r1.body.question?.text).toBe('Who is "riya"?');
      // Levenshtein <= 2, sorted by distance then alphabetically, at most 3 (Aradhya and Mihir are too far).
      expect(r1.body.question?.chips.map((c) => c.label)).toEqual(['Diya', 'Priya', 'Riyan']);
      const r2 = await h.answer(r1, { chipLabel: 'Priya' });
      expect(h.asked).toEqual(['Q_WHO_IS']);
      expect(lines(r2)).toEqual([`Send 10 USDC to Priya (${short(addr(0xc1))}) on Base Sepolia.`]);
      expect(h.repos.db2.findByNameKey('riya')).toEqual([]);
      await h.finish();
    });

    it('A-21: pasted new address -> Yes -> name "Mihir" (taken) -> name re-ask', async () => {
      const h = await harness('A-21');
      registerSensitive('address', NEW1);
      const r1 = await h.say(`send 10 usdc to ${NEW1}`);
      expect(r1.body.question?.code).toBe('Q_ADDRESS_CORRECT');
      expect(r1.body.question?.text).toContain(NEW1);
      expect(r1.body.question?.chips.map((c) => c.label)).toEqual(['Yes', 'No, re-enter']);
      const r2 = await h.answer(r1, { chipLabel: 'Yes' });
      expect(r2.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
      expect(r2.body.question?.input).toBe('text');
      expect(r2.body.question?.attempt).toBe(1);
      const r3 = await h.answer(r2, { text: 'Mihir' });
      expect(r3.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
      expect(r3.body.question?.attempt).toBe(2);
      // SQ-04 (OPEN): re-ask text = hint + one space + the original question.
      expect(r3.body.question?.text).toBe(
        'That name is already saved for another address. Pick another name. Save this address as?',
      );
      expect(h.repos.db2.findByAddress(NEW1)).toEqual([]);
      const r4 = await h.answer(r3, { text: 'Sam' });
      expect(r4.body.state).toBe('awaiting_confirmation');
      expect(h.asked).toEqual(['Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS', 'Q_NAME_FOR_ADDRESS']);
      // add_contact: one row per allowed chain, ens_name NULL.
      const rows = h.repos.db2.findByNameKey('sam');
      expect(rows.map((x) => x.chain_id).sort()).toEqual([SEPOLIA, BASE, ARB].sort());
      expect(rows.every((x) => x.address === NEW1 && x.ens_name === null && x.added_by === 'user_confirmed')).toBe(
        true,
      );
      await h.finish();
    });

    it('A-22: new address answered "No, re-enter" 4 times -> TOO_MANY_RETRIES', async () => {
      const h = await harness('A-22');
      registerSensitive('address', NEW1, NEW2);
      let r = await h.say(`send 10 usdc to ${NEW1}`);
      let noes = 0;
      for (let i = 0; i < 12 && r.body.state === 'awaiting_answer'; i++) {
        const code = r.body.question!.code;
        if (code === 'Q_ADDRESS_CORRECT') {
          noes++;
          r = await h.answer(r, { chipLabel: 'No, re-enter' });
        } else {
          expect(code).toBe('Q_ADDRESS_REENTER');
          expect(r.body.question?.input).toBe('address');
          r = await h.answer(r, { text: i % 4 === 1 ? NEW2 : NEW1 });
        }
      }
      expect(noes).toBe(4);
      expectError(r, 'TOO_MANY_RETRIES', "Let's start over. Nothing was sent.");
      expect(h.repos.db2.findByAddress(NEW1)).toEqual([]);
      noSubmission(h);
      await h.finish();
    });

    it('A-23: "send 10 usdc to riya.eth" with one address on all chains -> one Q_ADDRESS_CORRECT, DB2 rows with ens_name', async () => {
      const h = await harness('A-23');
      ensAllChains(h, 'riya.eth', ENS1);
      registerSensitive('ens', 'riya.eth');
      const r1 = await h.say('send 10 usdc to riya.eth');
      expect(r1.body.question?.code).toBe('Q_ADDRESS_CORRECT');
      // SQ-06 (OPEN): chains joined "A, B and C"; address shown in full, no emphasis markup.
      expect(r1.body.question?.text).toBe(`riya.eth → ${ENS1} on Sepolia, Base Sepolia and Arbitrum Sepolia. Correct?`);
      const r2 = await h.answer(r1, { chipLabel: 'Yes' });
      expect(r2.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
      expect(r2.body.question?.prefill).toBe('riya'); // SQ-03: prefilled with the first label
      const r3 = await h.answer(r2, { text: 'Riya' });
      expect(h.asked).toEqual(['Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS']);
      const rows = h.repos.db2.findByNameKey('riya');
      expect(rows.map((x) => x.chain_id).sort()).toEqual([SEPOLIA, BASE, ARB].sort());
      expect(rows.every((x) => x.ens_name === 'riya.eth' && x.address === ENS1)).toBe(true);
      expect(lines(r3)).toEqual([`Send 10 USDC to Riya (${short(ENS1)}) on Base Sepolia.`]);
      await h.finish();
    });

    it('A-24: ENS different per chain, no chain stated -> Q_ENS_CHAIN, chain pinned', async () => {
      const h = await harness('A-24');
      h.ens.set('riya.eth', coinType(BASE), ENS1).set('riya.eth', coinType(ARB), ENS2);
      registerSensitive('ens', 'riya.eth');
      const r1 = await h.say('send 10 usdc to riya.eth');
      expect(r1.body.question?.code).toBe('Q_ENS_CHAIN');
      expect(r1.body.question?.text).toBe('riya.eth has different addresses on different chains. Which one?');
      expect(r1.body.question?.chips.map((c) => c.label)).toEqual([
        `Base Sepolia (${short(ENS1)})`,
        `Arbitrum Sepolia (${short(ENS2)})`,
      ]);
      const r2 = await h.answer(r1, { chipLabel: 'Arbitrum Sepolia' });
      expect(r2.body.question?.code).toBe('Q_ADDRESS_CORRECT');
      expect(r2.body.question?.text).toBe(`riya.eth → ${ENS2} on Arbitrum Sepolia. Correct?`);
      const r3 = await h.answer(r2, { chipLabel: 'Yes' });
      const r4 = await h.answer(r3, { text: 'Riya' });
      expect(h.asked).toEqual(['Q_ENS_CHAIN', 'Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS']);
      // Pinned to Arbitrum even though Base has the larger balance (80 vs 60); rows only for the matched chain.
      expect(lines(r4)).toEqual([`Send 10 USDC to Riya (${short(ENS2)}) on Arbitrum Sepolia.`]);
      expect(h.repos.db2.findByNameKey('riya').map((x) => x.chain_id)).toEqual([ARB]);
      expectHandedOff(await h.confirm(r4, 'yes'));
      expectEnvelope(h, r4.body.request_id, [
        usdcIntent({ step: 0, chain: ARB, token_address: USDC_ADDR[ARB], amount: usdc('10'), recipient: ENS2 }),
      ]);
      await h.finish();
    });

    it('A-25: saved ENS contact whose record changed -> Q_ENS_CHANGED', async () => {
      const h = await harness('A-25');
      h.addContact('Riya', ENS1, [BASE, ARB], 'riya.eth');
      h.ens.set('riya.eth', coinType(BASE), ENS2).set('riya.eth', coinType(ARB), ENS2);
      const r1 = await h.say('send 10 usdc to riya');
      expect(r1.body.question?.code).toBe('Q_ENS_CHANGED');
      expect(r1.body.question?.text).toBe(
        `riya.eth now points to ${short(ENS2)} (saved: ${short(ENS1)}). Use the new address?`,
      );
      expect(r1.body.question?.chips.map((c) => c.label)).toEqual(['Use new address', 'Keep saved address', 'Cancel']);
      const r2 = await h.answer(r1, { chipLabel: 'Use new address' });
      expect(h.asked).toEqual(['Q_ENS_CHANGED']);
      expect(h.repos.db2.findByNameKey('riya').every((x) => x.address === ENS2)).toBe(true);
      expect(lines(r2)).toEqual([`Send 10 USDC to Riya (${short(ENS2)}) on Base Sepolia.`]);
      await h.finish();
    });

    it('A-26: "send 50 usdc to aradhya on sepolia" (no Sepolia row) -> silent reuse note', async () => {
      const h = await harness('A-26', {
        balances: {
          11155111: { USDC: '100', ETH: '0.1' },
          84532: { USDC: '80', ETH: '0.1' },
          421614: { USDC: '60', ETH: '0.1' },
        },
      });
      const r = await h.say('send 50 usdc to aradhya on sepolia');
      expect(h.asked).toEqual([]);
      expect(r.body.state).toBe('awaiting_confirmation');
      expect(lines(r)).toEqual(['Send 50 USDC to Aradhya (0x3fA9…c21E) on Sepolia.']);
      // §9.5 names the chain the address was reused from; the spec does not say which of the two when both exist.
      expect(r.body.summary?.notes).toHaveLength(1);
      expect(r.body.summary?.notes[0]).toMatch(/^Same address as on (Base|Arbitrum) Sepolia\.$/);
      expect(
        h.repos.db2
          .findByNameKey('aradhya')
          .map((x) => x.chain_id)
          .sort(),
      ).toEqual([BASE, ARB].sort()); // no DB2 row written
      const reused = h.rows<{ reused_from_chain_id: number | null }>(
        'SELECT reused_from_chain_id FROM db3_address_placeholders',
      );
      expect([BASE, ARB]).toContain(reused[0]?.reused_from_chain_id);
      expectHandedOff(await h.confirm(r, 'yes'));
      expectEnvelope(h, r.body.request_id, [
        usdcIntent({
          step: 0,
          chain: SEPOLIA,
          token_address: USDC_ADDR[SEPOLIA],
          amount: usdc('50'),
          recipient: ARADHYA,
        }),
      ]);
      await h.finish();
    });

    it('A-27: "send 150 usdc to mihir" -> LIMIT_PER_TX', async () => {
      const h = await harness('A-27', {
        balances: {
          84532: { USDC: '200', ETH: '0.1' },
          421614: { USDC: '60', ETH: '0.1' },
          11155111: { USDC: '0', ETH: '0.1' },
        },
      });
      const r = await h.say('send 150 usdc to mihir');
      expectError(r, 'LIMIT_PER_TX', '150 USDC is over your per-payment limit of 100.');
      noSubmission(h);
      await h.finish();
    });

    it('A-28: three payments of 100 after 50 spent today -> LIMIT_DAILY with remaining 250', async () => {
      const h = await harness('A-28', {
        balances: {
          84532: { USDC: '400', ETH: '0.1' },
          421614: { USDC: '400', ETH: '0.1' },
          11155111: { USDC: '0', ETH: '0.1' },
        },
      });
      h.addContact('Priya', addr(0xc1), [BASE, ARB]);
      seedSpend(h, { amount: '50' });
      const r = await h.say('send 100 usdc to aradhya, 100 usdc to mihir and 100 usdc to priya');
      expectError(r, 'LIMIT_DAILY', "This would go over today's USDC limit. You can still send 250 today.");
      noSubmission(h);
      await h.finish();
    });

    it('A-29: group over the daily limit, user says yes -> override note, hand-off proceeds', async () => {
      const h = await harness('A-29', {
        balances: {
          84532: { USDC: '400', ETH: '0.1' },
          421614: { USDC: '0', ETH: '0.1' },
          11155111: { USDC: '0', ETH: '0.1' },
        },
      });
      const names = ['alice.iitr.eth', 'bob.iitr.eth', 'carol.iitr.eth'];
      h.subnames.children.set('iitr.eth', names);
      names.forEach((n, i) => h.ens.set(n, coinType(BASE), addr(0xb1 + i)));
      seedSpend(h, { amount: '50' });
      const r1 = await h.say('send 100 usdc to everyone under iitr.eth on base');
      expect(r1.body.question?.code).toBe('Q_GROUP_MEMBERS');
      const r2 = await h.answer(r1, { selectedLabels: names });
      expect(r2.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
      expect(r2.body.question?.text).toBe(
        "This sends 300 USDC, but only 250 is left of today's 300 limit. Go ahead this once?",
      );
      expect(r2.body.question?.chips.map((c) => c.label)).toEqual(['Yes, this once', 'No']);
      const r3 = await h.answer(r2, { chipLabel: 'Yes, this once' });
      expect(h.asked).toEqual(['Q_GROUP_MEMBERS', 'Q_LIMIT_OVERRIDE']);
      expect(r3.body.state).toBe('awaiting_confirmation');
      expect(r3.body.summary?.notes).toContain("Today's limit was lifted once for this group payment.");
      expect(lines(r3)).toEqual([`Send 100 USDC each to 3 members of iitr.eth on Base Sepolia: ${names.join(', ')}.`]);
      expectHandedOff(await h.confirm(r3, 'yes'));
      expect(h.envelope.intents.map((i) => i.intent_id)).toEqual(['i', 'i', 'i']);
      expect(spend(h).filter((s) => s.status === 'pending')).toHaveLength(3);
      // DB5 is unchanged by the override.
      expect(h.repos.db5.getAll().daily_max.USDC).toBe('300');
      await h.finish();
    });

    it('A-29: group over the daily limit, user says no -> DISCARDED, nothing handed off', async () => {
      const h = await harness('A-29', {
        balances: {
          84532: { USDC: '400', ETH: '0.1' },
          421614: { USDC: '0', ETH: '0.1' },
          11155111: { USDC: '0', ETH: '0.1' },
        },
      });
      const names = ['alice.iitr.eth', 'bob.iitr.eth', 'carol.iitr.eth'];
      h.subnames.children.set('iitr.eth', names);
      names.forEach((n, i) => h.ens.set(n, coinType(BASE), addr(0xb1 + i)));
      seedSpend(h, { amount: '50' });
      // Same fixture (same prompts), a different last answer.
      const r1 = await h.say('send 100 usdc to everyone under iitr.eth on base');
      const r2 = await h.answer(r1, { selectedLabels: names });
      const r3 = await h.answer(r2, { chipLabel: 'No' });
      expect(r3.body.state).toBe('done'); // SQ-15 (OPEN): reply text is the §13.3 "Cancelled. Nothing was sent."
      expect(r3.body.messages.map((m) => m.text)).toEqual(['Cancelled. Nothing was sent.']);
      noSubmission(h);
      await h.finish();
    });

    it('A-30: need exceeds all balances -> INSUFFICIENT_FUNDS with per-chain numbers', async () => {
      const h = await harness('A-30', {
        balances: {
          11155111: { USDC: '0', ETH: '0.1' },
          84532: { USDC: '30', ETH: '0.1' },
          421614: { USDC: '20', ETH: '0.1' },
        },
      });
      const r = await h.say('send 100 usdc to mihir');
      expectError(r, 'INSUFFICIENT_FUNDS');
      // SQ-08 (OPEN, spec conflict §10.4 "per chain" vs §15 template): the interim behaviour is the §15 template with
      // {have} the total and {chains} the chain names. Per-chain numbers (A-30 "per-chain numbers") are not asserted
      // until the human answers.
      const m = r.body.error!.message;
      expect(m).toBe(
        "You don't have enough USDC: you need 100, and can use 50 across Sepolia, Base Sepolia and Arbitrum Sepolia.",
      );
      noSubmission(h);
      await h.finish();
    });

    it('A-31: USDC payment on a chain with 0 ETH -> NO_GAS', async () => {
      const h = await harness('A-31', { balances: { 84532: { USDC: '80', ETH: '0' } } });
      const r = await h.say('send 50 usdc to aradhya on base');
      expectError(r, 'NO_GAS', 'You need at least 0.002 ETH on Base Sepolia for network fees.');
      noSubmission(h);
      await h.finish();
    });

    it('A-32: four bridges needed -> LIMIT_BRIDGES', async () => {
      // USDC: Base 0, Sepolia 80, Arbitrum 80 -> 100 USDC on Base needs two bridges (80 then the rest).
      // ETH: Base 0.003 (0.001 spendable), Sepolia 0.03 (0.02), Arbitrum 0.05 (0.048) -> 0.05 ETH on Base needs two more.
      const h = await harness('A-32', {
        balances: {
          11155111: { USDC: '80', ETH: '0.03' },
          84532: { USDC: '0', ETH: '0.003' },
          421614: { USDC: '80', ETH: '0.05' },
        },
      });
      const r = await h.say('send 100 usdc to aradhya on base and 0.05 eth to mihir on base');
      expectError(r, 'LIMIT_BRIDGES', 'This needs 4 transfers between chains; your limit is 3.');
      noSubmission(h);
      await h.finish();
    });
  });
}
