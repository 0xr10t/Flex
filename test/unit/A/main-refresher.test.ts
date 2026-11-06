// Privacy fix 8 wiring: main() reads balances once at startup through the background refresher (not because of a message),
// and close() stops it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, productionFactories, type RunningAgent } from '../../../src/index.js';
import { testConfig } from '../../fakes/context.js';
import { FakeRpc } from '../../fakes/io.js';
import { FixtureLlmClient } from '../../fakes/llm.js';

let running: RunningAgent | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(rpc: FakeRpc): Promise<RunningAgent> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-main-'));
  const cfg = testConfig();
  cfg.auth = { ui_token_file: join(dir, 'ui'), execution_report_token_file: join(dir, 'report') };
  cfg.execution = { ...cfg.execution, outbound_token_file: join(dir, 'out') };
  cfg.db = { path: join(dir, 'agent.db') };
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(cfg));
  let key: string | null = null;
  running = await main(
    { ...productionFactories, createRpc: () => rpc, createLlm: () => new FixtureLlmClient({ calls: [] }) },
    {
      configPath: path,
      keyStore: { get: () => key, set: (v) => (key = v) },
      logFile: join(dir, 'agent.log'),
      listen: false,
    },
  );
  return running;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('privacy fix 8: main() runs the balance refresher', () => {
  it('reads every allowed chain once at startup and fills DB4', async () => {
    const rpc = new FakeRpc();
    rpc.usdc.set(84532, 7_000_000n);
    const agent = await start(rpc);
    await settle();
    expect(rpc.calls).toHaveLength(6);
    expect(agent.repos.db4.get(84532, 'USDC')).toMatchObject({ status: 'ok', balance: '7' });
  });

  it('close() stops the refresher', async () => {
    const rpc = new FakeRpc();
    const agent = await start(rpc);
    await settle();
    await agent.close();
    running = undefined;
    const n = rpc.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(rpc.calls).toHaveLength(n);
  });
});
