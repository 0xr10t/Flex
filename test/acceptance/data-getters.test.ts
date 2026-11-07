import { afterEach, expect, it } from 'vitest';
import { harness, type Harness, REPORT_TOKEN } from './harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.finish({ allowUnused: true });
});
it('lists database resources and reads contacts without changing the database or calling the model', async () => {
  h = await harness('A-01');
  const before = h.db.prepare('select total_changes() n').get();
  const catalog = await h.http('GET', '/v1/data');
  expect(catalog.status).toBe(200);
  expect(JSON.stringify(catalog.json)).toContain('cre-submissions');
  const result = await h.http('GET', '/v1/data/contacts?limit=2&chain_id=84532');
  expect(result.status).toBe(200);
  expect(result.json.total).toBe(2);
  expect(result.json.rows).toHaveLength(2);
  expect(h.db.prepare('select total_changes() n').get()).toEqual(before);
  expect(h.llm.recorded).toHaveLength(0);
});
it('requires authentication and validates resource names and pagination', async () => {
  h = await harness('A-01');
  expect((await h.http('GET', '/v1/data/contacts', { token: null })).status).toBe(401);
  expect((await h.http('GET', '/v1/data/contacts', { token: REPORT_TOKEN })).status).toBe(401);
  expect((await h.http('GET', '/v1/data/contacts?limit=101')).status).toBe(400);
  expect((await h.http('GET', '/v1/data/contacts?sql=drop')).status).toBe(400);
  expect((await h.http('GET', '/v1/data/not-a-table')).status).toBe(404);
});
it('keeps temporary reads within an existing session and preserves a pending confirmation', async () => {
  h = await harness('A-01');
  const sid = await h.open();
  const summary = (await h.say('Send 50 USDc to ARADHYA')).body;
  expect(summary.state).toBe('awaiting_confirmation');
  const calls = h.llm.recorded.length;
  const before = h.db.prepare('select total_changes() n').get();
  expect((await h.http('GET', '/v1/data/amounts')).status).toBe(400);
  expect((await h.http('GET', '/v1/data/amounts?session_id=ses_ffffffffffff')).status).toBe(404);
  const rows = await h.http('GET', `/v1/data/amounts?session_id=${sid}`);
  expect(rows.status).toBe(200);
  expect(rows.json.rows).not.toHaveLength(0);
  expect(h.db.prepare('select total_changes() n').get()).toEqual(before);
  expect(h.llm.recorded).toHaveLength(calls);
  const done = await h.confirm(summary, 'yes');
  expect(done.body.state).toBe('done');
});
it('covers every agent table and reports unavailable wallet data explicitly', async () => {
  h = await harness('A-01');
  const sid = await h.open();
  for (const resource of [
    'amounts',
    'contacts',
    'recipients',
    'balances',
    'limits',
    'transactions',
    'autopays',
    'session',
    'prompts',
    'history',
    'handoffs',
  ]) {
    const scope = ['amounts', 'recipients', 'session', 'prompts', 'history'].includes(resource)
      ? `?session_id=${sid}`
      : '';
    expect((await h.http('GET', `/v1/data/${resource}${scope}`)).status, resource).toBe(200);
  }
  const unavailable = await h.http('GET', '/v1/data/steps');
  expect(unavailable.status).toBe(200);
  expect(unavailable.json.status).toBe('unavailable');
});
it('runs the CLI getter through the real authenticated API without consuming confirmation', async () => {
  h = await harness('A-01');
  const { AgentClient } = await import('../../src/cli/agent/client.js');
  const { Chat } = await import('../../src/cli/chat.js');
  const local = h;
  let failGetters = false;
  const transport: typeof fetch = async (_url, init) => {
    const url = new URL(String(_url));
    if (failGetters && url.pathname.startsWith('/v1/data/')) return new Response('{}', { status: 404 });
    const result = await local.app.inject({
      method: init?.method as 'GET' | 'POST' | 'DELETE',
      url: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string | undefined,
    });
    return new Response(result.statusCode === 204 ? null : result.body, { status: result.statusCode });
  };
  const { UI_TOKEN } = await import('./harness.js');
  const chat = new Chat({
    connect: async () => ({
      baseUrl: 'http://127.0.0.1:8787',
      walletUrl: 'http://127.0.0.1:8788/',
      token: UI_TOKEN,
      started: false,
      stop: () => undefined,
    }),
    client: (endpoint) => new AgentClient(endpoint.baseUrl, endpoint.token, transport),
    timezone: 'Asia/Kolkata',
    openPage: () => true,
  });
  await chat.connect();
  await chat.send('Send 50 USDc to ARADHYA');
  const reads = await chat.getData(['contacts', '--chain', 'base', '--json']);
  expect(JSON.parse(reads.map((l) => l.map((s) => s.text).join('')).join('\n')).total).toBe(2);
  expect(local.exec.submissions).toHaveLength(0);
  failGetters = true;
  await chat.getData(['contacts']);
  const done = await chat.send('y');
  expect(
    done
      .flat()
      .map((s) => s.text)
      .join('\n'),
  ).toContain('Sent to your wallet');
  expect(local.exec.submissions).toHaveLength(1);
  await chat.close();
});
