// Orchestrator smoke tests for the frozen contracts (contracts-v1).
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE, QUESTION_INPUT, QUESTION_TEXT } from '../../../src/contracts/catalog.js';
import { STEP_ORDER } from '../../../src/contracts/step.js';
import { ERROR_CODES, QUESTION_CODES } from '../../../src/contracts/types.js';
import { registry } from '../../../src/pipeline/registry.js';
import { SCHEMA, buildPaymentsSchema, compileEphemeral, validators } from '../../../src/schemas/index.js';
import { makeTestContext, ARADHYA } from '../../fakes/context.js';
import { FixtureLlmClient } from '../../fakes/llm.js';
import { LlmFailed } from '../../../src/contracts/llm.js';

describe('contracts-v1', () => {
  it('§12.1 LLM #1 example outputs validate against the amounts schema', () => {
    expect(
      validators.amounts({
        amounts: [{ phrase: '50 usdc', number: '50', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
      }),
    ).toBe(true);
    expect(validators.amounts({ amounts: [{ phrase: 'x' }] })).toBe(false);
  });

  it('§12.2 template accepts the §8.10 LLM #4 example and rejects foreign placeholders', () => {
    const schema = buildPaymentsSchema({
      maxItems: 6,
      kinds: ['i'],
      amounts: ['amount_aa11bb22', 'amount_cc33dd44'],
      recipients: ['address_0a0b0c0d', 'address_1e1f2a2b'],
      chains: [84532, 421614],
    });
    const v = compileEphemeral(schema);
    const item = {
      kind: 'i',
      amount: 'amount_aa11bb22',
      recipient: 'address_0a0b0c0d',
      chain: 84532,
      frequency: null,
      interval: null,
      times_per_week: null,
      days_of_week: null,
      day_of_month: null,
    };
    expect(v({ payments: [item] })).toBe(true);
    expect(v({ payments: [{ ...item, amount: 'amount_deadbeef' }] })).toBe(false);
    expect(v({ payments: [{ ...item, chain: 11155111 }] })).toBe(false);
  });

  it('§12.5 E1 envelope validates; extra fields are rejected', () => {
    const env = {
      version: '2',
      request_id: 'req_5d1c0a9b8e7f',
      wallet_address: '0x00000000000000000000000000000000000000Aa',
      created_at: '2026-11-06T04:31:10Z',
      intents: [
        {
          intent_id: 'i',
          step: 0,
          depends_on: [],
          token: 'USDC',
          token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          chain_id: 84532,
          recipients: [{ amount: { value: '50', base_units: '50000000', decimals: 6 }, recipient: ARADHYA }],
        },
      ],
    };
    expect(validators.handoffEnvelope(env)).toBe(true);
    expect(validators.handoffEnvelope({ ...env, memo: 'x' })).toBe(false);
  });

  it('§12.3 internal plan schema enforces placeholder patterns', () => {
    const i = {
      intent_id: 'i',
      step: 0,
      depends_on: [],
      token: 'USDC',
      chain_id: 84532,
      recipients: [{ amount: 'amount_a1b2c3d4', recipient: 'address_0f1e2d3c', reused_from_chain_id: null }],
    };
    expect(validators.internalPlan([i])).toBe(true);
    expect(validators.internalPlan([{ ...i, amount: '50' }])).toBe(false);
  });

  it('§13.4/§15 catalogue covers every code', () => {
    for (const c of QUESTION_CODES) {
      expect(QUESTION_TEXT[c]).toBeTypeOf('function');
      expect(QUESTION_INPUT[c]).toBeTruthy();
    }
    for (const c of ERROR_CODES) expect(ERROR_MESSAGE[c]).toBeTypeOf('function');
    expect(QUESTION_CODES).toHaveLength(29); // Includes the v2 monthly-schedule clarification.
    expect(ERROR_CODES).toHaveLength(43); // Includes ENS lookup outages, v2 planning, cancellation and privacy errors.
  });

  it('§3.3 registry wires a real step for S0–S12 in fixed order (Phase 2)', async () => {
    const { s0 } = await import('../../../src/pipeline/s0-balances.js');
    const { s12 } = await import('../../../src/pipeline/s12-handoff.js');
    expect(Object.keys(registry)).toEqual([...STEP_ORDER]);
    for (const s of STEP_ORDER) expect(typeof registry[s].step).toBe('function');
    expect(registry.s0).toBe(s0);
    expect(registry.s12).toBe(s12);
  });

  it('§7.1 DB2 invariant in fake repos', () => {
    const { repos } = makeTestContext();
    expect(repos.db2.addContact({ name: 'mihir', address: ARADHYA, chain_ids: [84532], ens_name: null })).toEqual({
      ok: false,
      reason: 'name_taken',
    });
    expect(repos.db2.addContact({ name: 'Other', address: ARADHYA, chain_ids: [84532], ens_name: null })).toEqual({
      ok: false,
      reason: 'address_has_other_name',
    });
  });

  it('FixtureLlmClient retries once and throws LlmFailed after two invalid outputs', async () => {
    const llm = new FixtureLlmClient({
      calls: [
        { name: 'request_type', match: 'hi', output: { bad: true } },
        { name: 'request_type', match: 'hi', output: { bad: true }, attempt: 2 },
      ],
    });
    await expect(
      llm.call({ name: 'request_type', system: 's', user: 'Message: <<<hi>>>', schema: SCHEMA.requestType }),
    ).rejects.toBeInstanceOf(LlmFailed);
    expect(llm.recorded).toHaveLength(2);
  });
});
