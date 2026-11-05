// Orchestrator tests for src/contracts/money.ts (NFR-06, §10.4, §12.5, §13.1).
import { describe, expect, it } from 'vitest';
import {
  compareDecimal,
  fromBaseUnits,
  isDecimalString,
  mulDivCeil,
  mulDivFloor,
  normalizeDecimal,
  shortAddress,
  toBaseUnits,
} from '../../../src/contracts/money.js';

describe('money helpers', () => {
  it('§12.5 base units via bigint: 50 USDC → 50000000', () => {
    expect(toBaseUnits('50', 6)).toBe(50_000_000n);
    expect(toBaseUnits('10.2', 6)).toBe(10_200_000n);
    expect(toBaseUnits('0.000000000000000001', 18)).toBe(1n);
  });
  it('§8.4 precision: more decimals than the token allows throws', () => {
    expect(() => toBaseUnits('0.1234567', 6)).toThrow('too many decimals');
    expect(toBaseUnits('1.500000000', 6)).toBe(1_500_000n);
  });
  it('§12.5 value has no trailing zeros', () => {
    expect(fromBaseUnits(20_400_000n, 6)).toBe('20.4');
    expect(fromBaseUnits(50_000_000n, 6)).toBe('50');
    expect(fromBaseUnits(0n, 18)).toBe('0');
    expect(normalizeDecimal('010.50', 6)).toBe('10.5');
  });
  it('§10.4 E2 bridge math: deliverable floor(60×100/102), padded ceil(20×102/100) = 20.4', () => {
    expect(fromBaseUnits(mulDivFloor(60_000_000n, 100n, 102n), 6)).toBe('58.823529');
    expect(fromBaseUnits(mulDivCeil(20_000_000n, 102n, 100n), 6)).toBe('20.4');
  });
  it('decimal validation and comparison', () => {
    expect(isDecimalString('5')).toBe(true);
    expect(isDecimalString('5.')).toBe(false);
    expect(isDecimalString('-1')).toBe(false);
    expect(compareDecimal('10', '9.99', 6)).toBe(1);
    expect(compareDecimal('0.10', '0.1', 6)).toBe(0);
  });
  it('§13.1 short address 0x3fA9…c21E', () => {
    expect(shortAddress('0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E')).toBe('0x3fA9…c21E');
  });
});
