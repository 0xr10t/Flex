// The CLI's conversation against the real agent app (recorded model replies): a request becomes a summary in the
// box, `y` hands it off and opens the wallet, `n` drops it, and the limits commands read and write the settings API.

import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient } from '../../src/cli/agent/client.js';
import type { AgentEndpoint } from '../../src/cli/agent/launcher.js';
import { Chat } from '../../src/cli/chat.js';
import type { WatchOptions } from '../../src/cli/agent/progress.js';
import type { Line } from '../../src/cli/repl.js';
import { harness, TZ, UI_TOKEN, type Harness } from './harness.js';

const WALLET_URL = 'http://127.0.0.1:8788/';
const text = (lines: Line[]): string[] => lines.map((l) => l.map((s) => s.text).join(''));

let h: Harness | undefined;
afterEach(async () => {
  await h?.finish({ allowUnused: true });
  h = undefined;
});

async function chatOn(
  fixture: string,
  extra: { walletToken?: string; watches?: WatchOptions[] } = {},
): Promise<{ chat: Chat; opened: string[] }> {
  h = await harness(fixture);
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const endpoint: AgentEndpoint = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: UI_TOKEN,
    walletUrl: WALLET_URL,
    ...(extra.walletToken ? { walletToken: extra.walletToken } : {}),
    started: false,
    stop: () => undefined,
  };
  const opened: string[] = [];
  const chat = new Chat({
    connect: async () => endpoint,
    client: (e) => new AgentClient(e.baseUrl, e.token),
    timezone: TZ,
    openPage: (url) => (opened.push(url), true),
    watch: (options) => {
      extra.watches?.push(options);
      return { stop: () => undefined, done: new Promise(() => undefined) };
    },
  });
  return { chat, opened };
}

describe('CLI conversation with the agent', () => {
  it('connects, shows the summary, and hands off on y, opening the wallet', async () => {
    const { chat, opened } = await chatOn('A-01');
    expect(text(await chat.connect())).toEqual(['Connected to the agent']);

    const summary = text(await chat.send('Send 50 USDc to ARADHYA'));
    expect(summary).toEqual([
      'Please confirm:',
      '1. Send 50 USDC to Aradhya (0x3fA9…c21E) on Base Sepolia.',
      'Spent today after this: 50 of 300 USDC.',
      'Confirm?  [y] Yes  [n] No',
    ]);
    expect(h!.exec.submissions).toHaveLength(0);

    const done = text(await chat.send('y'));
    expect(done[0]).toBe('Sent to your wallet for signing.');
    // the wallet opens on its approval view for exactly this request
    const approveUrl = `${WALLET_URL}#approve=${h!.exec.submissions[0]!.envelope.request_id}`;
    expect(done.at(-1)).toBe(`Opened your wallet to approve it in MetaMask: ${approveUrl}`);
    expect(opened).toEqual([approveUrl]);
    expect(h!.exec.submissions).toHaveLength(1);
    await chat.close();
  });

  it('follows the handed-off request in the wallet and prints what happens in the conversation', async () => {
    const watches: WatchOptions[] = [];
    const { chat } = await chatOn('A-01', { walletToken: 'wallet-token', watches });
    const updates: Line[][] = [];
    chat.onUpdate((lines) => updates.push(lines));
    await chat.send('Send 50 USDc to ARADHYA');
    const done = text(await chat.send('y'));
    expect(done.at(-1)).toBe('I will show here what happens once you approve or reject it.');
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      walletUrl: WALLET_URL,
      token: 'wallet-token',
      requestId: h!.exec.submissions[0]!.envelope.request_id,
    });
    expect([...watches[0]!.names!]).toEqual([['0x3fa9…c21e', 'Aradhya']]);
    watches[0]!.onLines([[{ text: '✓ Went through', tone: 5 }]]);
    expect(updates).toEqual([[[{ text: '✓ Went through', tone: 5 }]]]);
    await chat.close();
  });

  it('does not promise to follow a request without the wallet token', async () => {
    const watches: WatchOptions[] = [];
    const { chat } = await chatOn('A-01', { watches });
    chat.onUpdate(() => undefined);
    await chat.send('Send 50 USDc to ARADHYA');
    const done = text(await chat.send('y'));
    expect(done.at(-1)).toMatch(/^Opened your wallet/);
    expect(watches).toEqual([]);
    await chat.close();
  });

  it('drops the plan on n and sends nothing', async () => {
    const { chat, opened } = await chatOn('A-01');
    await chat.send('Send 50 USDc to ARADHYA');
    const dropped = text(await chat.send('n'));
    expect(dropped).toEqual(["OK, I've dropped that. Tell me what you'd like instead."]);
    expect(h!.exec.submissions).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  it('lists the limits and changes one through the settings API', async () => {
    const { chat } = await chatOn('A-01');
    const listed = text(await chat.limits([]));
    expect(listed.some((l) => /^daily_max +USDC 300 · ETH 0\.15$/.test(l))).toBe(true);
    expect(listed.some((l) => /^autopay_max_weeks +52$/.test(l))).toBe(true);
    const changed = text(await chat.limits(['daily_max', 'usdc', '250']));
    expect(changed[0]).toBe('Updated daily_max.');
    expect(changed.some((l) => /^daily_max +USDC 250 · ETH 0\.15$/.test(l))).toBe(true);
    expect(text(await chat.limits(['daily_max', '250']))).toEqual([
      'Give an entry and a value: /limits daily_max USDC <value>',
    ]);
    const refused = text(await chat.limits(['autopay_max_weeks', '9999']));
    expect(refused[0]).toBe("The agent didn't accept that value:");
    expect(text(await chat.limits(['nope', '1']))).toEqual(["There's no limit called nope. Type /limits to see them."]);
  });

  it('shows a question with numbered choices and answers it by number, then cancels', async () => {
    const { chat } = await chatOn('A-07');
    const asked = text(await chat.send('send 5 more'));
    const usdc = asked.findIndex((l) => /^\[\d\] USDC/.test(l));
    expect(asked[0]).toMatch(/USDC or ETH/);
    expect(usdc).toBeGreaterThan(0);
    expect(asked.at(-1)).toBe('type a number, or answer in your own words · or cancel');

    const next = text(await chat.send(asked[usdc]!.slice(1, 2)));
    expect(next[0]).toBe('Who should receive this? Enter their wallet address, ENS name or saved contact name.');
    expect(next.at(-1)).toBe('type your answer · or cancel');

    expect(text(await chat.cancel())).toEqual(['Cancelled. Nothing was sent.']);
    expect(text(await chat.cancel())).toEqual(['Nothing is waiting to be cancelled.']);
    expect(h!.exec.submissions).toHaveLength(0);
  });

  it('starts a new session on /new', async () => {
    const { chat } = await chatOn('A-01');
    await chat.connect();
    expect(text(await chat.newSession())).toEqual(['Started a new session. Earlier requests here are forgotten.']);
  });
});
