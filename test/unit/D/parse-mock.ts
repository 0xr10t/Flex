// Stand-in for Lane B's parseAmountText (§8.4 step 3 code parser) used via vi.mock until Lane B merges.
// Supports digits with commas/decimals and a few English number words; enough for Lane D answers and end phrases.
import type { ParsedAmount } from '../../../src/contracts/step.js';

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  twenty: 20,
};

export function fakeParseAmountText(text: string): ParsedAmount {
  const t = text.trim().toLowerCase();
  if (/^\d[\d,]*(\.\d+)?$/.test(t)) {
    const v = t
      .replace(/,/g, '')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
    if (/^0+(\.0+)?$/.test(v)) return { ok: false, reason: 'zero' };
    return { ok: true, value: v.replace(/^0+(?=\d)/, '') };
  }
  const w = WORDS[t];
  if (w !== undefined) return { ok: true, value: String(w) };
  return { ok: false, reason: 'unparseable' };
}
