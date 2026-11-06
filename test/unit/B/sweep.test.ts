// Tests: SQ-O-01 / SQB-23 sweep of repeated tagged names (src/lexical/sweep.ts), pure function.
import { describe, expect, it } from 'vitest';
import { PERSON, sweepRepeats, type Masking } from '../../../src/lexical/sweep.js';

const ADDR = 'address_0a1b2c3d';
const ADDR2 = 'address_99887766';

function tag(source: string, text: string, w: string, from = 0): Masking {
  const start = source.indexOf(text, from);
  if (start < 0) throw new Error(`no ${text}`);
  return { start, end: start + text.length, text, with: w };
}
/** Applies all maskings right to left (offsets stay valid). */
function apply(source: string, ms: Masking[]): string {
  let out = source;
  for (const m of [...ms].sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + m.with + out.slice(m.end);
  return out;
}
const full = (src: string, tagged: Masking[]): string => apply(src, [...tagged, ...sweepRepeats(src, tagged)]);

describe('sweepRepeats (SQ-O-01, SQB-23)', () => {
  it('SQ-O-01 sweeps every further case-insensitive whole-word repeat of a payee to its placeholder', () => {
    const src = 'Send 5 to Aradhya. aradhya is my flatmate and ARADHYA likes pizza';
    expect(full(src, [tag(src, 'Aradhya', ADDR)])).toBe(
      `Send 5 to ${ADDR}. ${ADDR} is my flatmate and ${ADDR} likes pizza`,
    );
  });

  it('SQ-O-01 mentioned names are swept to [person]', () => {
    const src = 'pay Aradhya for lunch Kabir had. Kabir says thanks';
    expect(full(src, [tag(src, 'Aradhya', ADDR), tag(src, 'Kabir', PERSON)])).toBe(
      `pay ${ADDR} for lunch [person] had. [person] says thanks`,
    );
  });

  it('SQ-O-01 offsets are exact: each result text is the slice of the source', () => {
    const src = 'Riya, then RIYA and riya';
    const extra = sweepRepeats(src, [tag(src, 'Riya', ADDR)]);
    expect(extra).toHaveLength(2);
    for (const m of extra) expect(src.slice(m.start, m.end)).toBe(m.text);
    expect(extra.map((m) => m.text).sort()).toEqual(['RIYA', 'riya']);
    expect(extra.every((m) => m.with === ADDR)).toBe(true);
  });

  it('SQ-O-01 whole word only: "Riya" is not swept inside "Riyaz"', () => {
    const src = 'pay Riya and Riyaz and Mariya';
    expect(full(src, [tag(src, 'Riya', ADDR)])).toBe(`pay ${ADDR} and Riyaz and Mariya`);
  });

  it('SQ-O-01 an occurrence inside another tagged span is left alone (riya.eth tagged on its own)', () => {
    const src = 'pay riya.eth and Riya later';
    const ms = [tag(src, 'riya.eth', ADDR2), tag(src, 'Riya', ADDR, src.indexOf('and'))];
    expect(full(src, ms)).toBe(`pay ${ADDR2} and ${ADDR} later`);
    // an untagged "Riya" sits next to riya.eth: only the exact tagged span is masked
    const src2 = 'pay riya.eth and Riya later';
    expect(sweepRepeats(src2, [tag(src2, 'Riya', ADDR, src2.indexOf('and')), tag(src2, 'riya.eth', ADDR2)])).toEqual(
      [],
    );
  });

  it('SQ-O-01 an occurrence inside a placeholder token is left alone', () => {
    const src = 'pay Mihir amount_a1b2c3d4 and [link 2] then Link and mihir';
    expect(full(src, [tag(src, 'Mihir', ADDR)])).toBe(`pay ${ADDR} amount_a1b2c3d4 and [link 2] then Link and ${ADDR}`);
    const src2 = 'pay amount and amount_a1b2c3d4 and [amount]';
    expect(sweepRepeats(src2, [tag(src2, 'amount', ADDR)])).toEqual([]);
    const src3 = 'pay address and address_0a1b2c3d';
    expect(sweepRepeats(src3, [tag(src3, 'address', ADDR)])).toEqual([]);
    const src4 = 'tell person about [person] and person';
    expect(sweepRepeats(src4, [tag(src4, 'person', PERSON)]).map((m) => m.start)).toEqual([src4.lastIndexOf('person')]);
  });

  it('SQ-O-01 a text tagged both payee and mentioned is NOT swept (F-12 will ask)', () => {
    const src = 'pay Sam and Sam is my friend; Sam again';
    const ms = [tag(src, 'Sam', ADDR), tag(src, 'Sam', PERSON, src.indexOf('is my'))];
    expect(sweepRepeats(src, ms)).toEqual([]);
  });

  it('SQ-O-01 two payee spans with one text: repeats get the earliest span placeholder', () => {
    const src = 'Sam, Sam, and Sam again';
    const first = tag(src, 'Sam', ADDR);
    const second = tag(src, 'Sam', ADDR2, 1);
    const extra = sweepRepeats(src, [second, first]);
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ text: 'Sam', with: ADDR });
    expect(extra[0]!.start).toBe(src.lastIndexOf('Sam'));
  });

  it('SQ-O-01 multi-word name with different whitespace and case; longer name swept before the shorter', () => {
    const src = 'Riya Shah and riya   shah and RIYA\nSHAH, also Riya alone';
    expect(full(src, [tag(src, 'Riya Shah', ADDR)])).toBe(`${ADDR} and ${ADDR} and ${ADDR}, also Riya alone`);
    const src2 = 'Riya Shah, Riya; riya shah';
    expect(full(src2, [tag(src2, 'Riya Shah', ADDR), tag(src2, 'Riya', ADDR2, 10)])).toBe(`${ADDR}, ${ADDR2}; ${ADDR}`);
  });

  it('SQ-O-01 nothing to sweep: no extra maskings, input unchanged', () => {
    const src = 'pay Aradhya 5 usdc';
    const tagged = [tag(src, 'Aradhya', ADDR)];
    const copy = structuredClone(tagged);
    expect(sweepRepeats(src, tagged)).toEqual([]);
    expect(tagged).toEqual(copy);
    expect(sweepRepeats(src, [])).toEqual([]);
  });
});
