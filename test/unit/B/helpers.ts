// Shared helpers for the Lane B tests (not a test file): drive a re-entrant step through answers (the runner
// semantics of src/contracts/step.ts), run the real S2 to build a scan, and check logger labels (§18).
import { expect } from 'vitest';
import type { StepContext, StepEntry, StepResult } from '../../../src/contracts/step.js';
import type { Answer, Question } from '../../../src/contracts/types.js';
import { s2 } from '../../../src/pipeline/s2-lexical.js';
import type { FixtureFile } from '../../fakes/llm.js';
import { makeTestContext, type TestContext, type TestContextOptions } from '../../fakes/context.js';

export interface Driven {
  result: StepResult;
  /** Every question asked, in order (re-asks included). */
  questions: Question[];
}

/**
 * Runs `entry.step`; for each `question` result feeds the next answer to `entry.onAnswer`; on `continue` from the
 * answer handler re-invokes `entry.step` (runner semantics). Stops when the answers run out (result = the pending
 * question) or on any non-question, non-continue result.
 */
export async function drive(entry: StepEntry, ctx: StepContext, answers: Answer[] = []): Promise<Driven> {
  const queue = [...answers];
  const questions: Question[] = [];
  let result = await entry.step(ctx);
  for (let guard = 0; guard < 50; guard++) {
    if (result.kind !== 'question') break;
    questions.push(result.question);
    const a = queue.shift();
    if (a === undefined) break;
    if (!entry.onAnswer) throw new Error('step has no onAnswer');
    result = await entry.onAnswer(ctx, result.question, a);
    if (result.kind === 'continue') result = await entry.step(ctx);
  }
  return { result, questions };
}

export const chip = (chip_id: string): Answer => ({ kind: 'chip', chip_id });
export const text = (t: string): Answer => ({ kind: 'text', text: t });

/** A context with typed_text set and the real S2 scan run on it. */
export async function scannedCtx(typed: string, o: TestContextOptions = {}): Promise<TestContext> {
  const ctx = makeTestContext({ ...o, req: { typed_text: typed, ...(o.req ?? {}) } });
  const r = await s2.step(ctx);
  if (r.kind !== 'continue') throw new Error(`S2 stopped: ${JSON.stringify(r)}`);
  return ctx;
}

export function fx(...calls: FixtureFile['calls']): FixtureFile {
  return { calls };
}

/** §18: event / rule_id labels start with a letter, contain no dots, at most 64 characters. */
export function expectLabelsOk(ctx: TestContext): void {
  for (const l of ctx.log.lines) {
    for (const v of [l.event, l.rule_id]) {
      if (v === undefined) continue;
      expect(v, `label ${v}`).toMatch(/^[A-Za-z][^.]{0,63}$/);
    }
  }
}

/** Minimal one-page PDF with one line of text. */
export function tinyPdf(line: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
