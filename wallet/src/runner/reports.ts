// Implements: §14.3 (POST /v1/execution/reports; 204 success, 400 malformed, 404 unknown) and rule 8. Reports wait in the
// store, so they survive a restart. OQ-14 (provisional): retry while the agent can't be reached, with a growing delay. A
// 400 or 404 won't change on retry, so it is logged by code and dropped.

import type { Logger } from '../log.js';
import type { ReportRow, Store } from '../store/store.js';

export interface ReportSenderDeps {
  store: Store;
  agentUrl: string;
  reportToken: string;
  log: Logger;
  now?: () => number;
  timeoutMs?: number;
  /** First retry delay; it doubles up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class ReportSender {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly url: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly deps: ReportSenderDeps) {
    this.url = `${deps.agentUrl.replace(/\/+$/, '')}/v1/execution/reports`;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.baseDelayMs = deps.baseDelayMs ?? 1000;
    this.maxDelayMs = deps.maxDelayMs ?? 300_000;
  }

  /** Sends whatever is due, then sets a timer for the next waiting report. */
  kick(): Promise<void> {
    this.again = true;
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private async loop(): Promise<void> {
    try {
      while (this.again && !this.stopped) {
        this.again = false;
        for (const report of this.deps.store.dueReports(this.now())) {
          if (this.stopped) return;
          await this.send(report);
        }
      }
      this.schedule();
    } catch {
      this.deps.log('report_sender_error', {});
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const next = this.deps.store.nextReportTime();
    if (next === null) return;
    this.timer = setTimeout(() => void this.kick(), Math.max(next - this.now(), 0));
    this.timer.unref();
  }

  private async send(report: ReportRow): Promise<void> {
    const fields = { request_id: report.request_id, ...(report.step === null ? {} : { step: report.step }) };
    let status: number | null = null;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.deps.reportToken}`, 'Content-Type': 'application/json' },
        body: report.body_json,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
    } catch {
      // No answer: the agent may be down, so this is retried below.
    }
    if (status !== null && status >= 200 && status < 300) {
      this.deps.store.closeReport(report.id, 'delivered');
      return;
    }
    if (status === 400 || status === 404) {
      this.deps.store.closeReport(report.id, 'abandoned');
      this.deps.log('report_abandoned', { ...fields, http_status: status });
      return;
    }
    const delay = Math.min(this.baseDelayMs * 2 ** report.attempts, this.maxDelayMs);
    this.deps.store.retryReport(report.id, this.now() + delay);
    this.deps.log('report_retry', {
      ...fields,
      attempts: report.attempts + 1,
      ...(status === null ? {} : { http_status: status }),
    });
  }
}
