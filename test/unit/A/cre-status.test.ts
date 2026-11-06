import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCreStatus } from '../../../src/server/cre-status.js';
import { makeServer, REPORT_TOKEN } from './server-harness.js';

describe('read-only CRE observations', () => {
  it('exposes broadcast transaction hashes as submissions, never as verified payment history', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cre-status-')), 'status.json');
    const tx = `0x${'ab'.repeat(32)}`;
    writeFileSync(
      path,
      JSON.stringify({
        status: 'broadcast_checked',
        broadcast: true,
        time: new Date().toISOString(),
        result: {
          mode: 'testnet-broadcast',
          results: [
            {
              chainId: 84532,
              executor: `0x${'12'.repeat(20)}`,
              id: `0x${'34'.repeat(32)}`,
              slot: '0',
              status: 'mined',
              tx,
            },
          ],
        },
      }),
    );
    expect(readCreStatus(path)).toMatchObject({
      broadcast: true,
      paymentExecuted: false,
      results: [{ outcome: 'submitted', txHash: tx }],
    });
  });
  it('never exposes raw CLI fields or treats a dry run as a payment, and expires old observations', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cre-status-')), 'status.json');
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({
        status: 'simulated',
        time: new Date(now).toISOString(),
        secret: 'never-expose',
        result: {
          mode: 'dry-run',
          results: [
            {
              chainId: 84532,
              executor: `0x${'12'.repeat(20)}`,
              id: `0x${'34'.repeat(32)}`,
              slot: '0',
              status: 'would_execute',
              redeem: 'never-expose',
            },
          ],
        },
      }),
    );
    const fresh = readCreStatus(path, now);
    expect(fresh.paymentExecuted).toBe(false);
    expect(fresh.results).toHaveLength(1);
    expect(JSON.stringify(fresh)).not.toContain('never-expose');
    expect(readCreStatus(path, now + 121000)).toMatchObject({ status: 'stale', results: [] });
    writeFileSync(path, '{broken');
    expect(readCreStatus(path, now).status).toBe('unavailable');
  });
  it('requires the UI token for simulation and plan status; report credentials cannot read them', async () => {
    const server = makeServer();
    try {
      for (const path of ['/v1/cre/status', '/v1/autopays/ap_missing']) {
        expect((await server.call('GET', path, { token: null })).status).toBe(401);
        expect((await server.call('GET', path, { token: REPORT_TOKEN })).status).toBe(401);
      }
      expect((await server.call('GET', '/v1/cre/status')).json).toMatchObject({
        broadcast: false,
        paymentExecuted: false,
      });
      expect((await server.call('GET', '/v1/autopays/ap_missing')).status).toBe(404);
    } finally {
      await server.app.close();
    }
  });
});
