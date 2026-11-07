import { afterEach, expect, it } from 'vitest';
import { harness, addr, ARADHYA, REPORT_TOKEN, type Harness } from './harness.js';
let h: Harness | undefined;
afterEach(async () => {
  await h?.finish({ allowUnused: true });
});
const patch = async (id: number, body: unknown, token?: string | null) =>
  h!.app.inject({
    method: 'PATCH',
    url: `/v1/contacts/${id}`,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token ?? (await import('./harness.js')).UI_TOKEN}` }),
    },
    payload: body as object,
  });
it('groups network rows into contacts and atomically saves name, address and network edits', async () => {
  h = await harness('A-01');
  const result = await h.http('GET', '/v1/contacts');
  expect(result.status).toBe(200);
  const contacts = result.json.contacts as Array<{ id: number; name: string; version: string; chain_ids: number[] }>;
  expect(contacts).toHaveLength(2);
  const contact = contacts.find((c) => c.name === 'Aradhya')!;
  expect(contact.chain_ids).toEqual([84532, 421614]);
  const updated = await patch(contact.id, {
    version: contact.version,
    name: 'Ari',
    address: addr(44),
    chain_ids: [11155111, 84532],
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ name: 'Ari', address: addr(44), chain_ids: [84532, 11155111] });
  expect(h.repos.db2.findByNameKey('aradhya')).toEqual([]);
  expect(
    h.repos.db2
      .findByNameKey('ari')
      .map((r) => r.chain_id)
      .sort((a, b) => a - b),
  ).toEqual([84532, 11155111]);
  expect(h.repos.db2.findByNameKey('ari').every((r) => r.address === addr(44))).toBe(true);
});
it('rejects stale saves and name/address collisions without partial writes', async () => {
  h = await harness('A-01');
  const page = await h.http('GET', '/v1/contacts');
  expect(page.status).toBe(200);
  const c = (
    page.json.contacts as Array<{ id: number; name: string; address: string; version: string; chain_ids: number[] }>
  ).find((c) => c.name === 'Aradhya')!;
  const original = h.repos.db2.listAll();
  expect(
    (await patch(c.id, { version: c.version, name: 'Mihir', address: c.address, chain_ids: c.chain_ids })).statusCode,
  ).toBe(409);
  expect(h.repos.db2.listAll()).toEqual(original);
  const body = { version: c.version, name: c.name, address: addr(50), chain_ids: c.chain_ids };
  expect((await patch(c.id, body)).statusCode).toBe(200);
  expect((await patch(c.id, { ...body, name: 'Stale Name' })).statusCode).toBe(409);
  expect(h.repos.db2.findByNameKey('stale name')).toEqual([]);
});
it('authenticates and validates contact writes', async () => {
  h = await harness('A-01');
  const listed = await h.http('GET', '/v1/contacts');
  expect(listed.status).toBe(200);
  const c = (listed.json.contacts as Array<{ id: number; version: string }>)[0]!;
  const good = { version: c.version, name: 'Valid Name', address: addr(52), chain_ids: [84532] };
  expect((await patch(c.id, good, null)).statusCode).toBe(401);
  expect((await patch(c.id, good, REPORT_TOKEN)).statusCode).toBe(401);
  for (const bad of [
    { name: 'eth' },
    { name: '0xabc' },
    { address: '0x1234' },
    { address: '0x0000000000000000000000000000000000000000' },
    { chain_ids: [] },
    { chain_ids: [1] },
    { chain_ids: [84532, 84532] },
    { extra: 'unknown' },
  ])
    expect((await patch(c.id, { ...good, ...bad })).statusCode).toBe(400);
});
it('keeps an existing payment summary bound to its original recipient', async () => {
  h = await harness('A-01');
  const summary = await h.say('Send 50 USDc to ARADHYA');
  expect(summary.body.state).toBe('awaiting_confirmation');
  const page = await h.http('GET', '/v1/contacts');
  expect(page.status).toBe(200);
  const c = (page.json.contacts as Array<{ id: number; name: string; version: string; chain_ids: number[] }>).find(
    (c) => c.name === 'Aradhya',
  )!;
  expect(
    (await patch(c.id, { version: c.version, name: c.name, address: addr(55), chain_ids: c.chain_ids })).statusCode,
  ).toBe(200);
  expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
  expect(JSON.stringify(h.exec.submissions[0]?.envelope)).toContain(ARADHYA);
  expect(JSON.stringify(h.exec.submissions[0]?.envelope)).not.toContain(addr(55));
});
it('rejects an address owned by another contact, including alternate casing', async () => {
  h = await harness('A-01');
  const [current, other] = (await h.http('GET', '/v1/contacts')).json
    .contacts as import('@flex/protocol').ContactRecord[];
  const before = h.repos.db2.listAll();
  const response = await patch(current!.id, {
    name: current!.name,
    address: other!.address.toLowerCase(),
    chain_ids: [11155111],
    version: current!.version,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().errors).toEqual(['address_has_other_name']);
  expect(h.repos.db2.listAll()).toEqual(before);
});
it('detaches ENS after a manual address change and supports replacing all network rows', async () => {
  h = await harness('A-01');
  h.db.prepare("UPDATE db2_address_book SET ens_name = 'alice.eth' WHERE name_key = 'aradhya'").run();
  const c = ((await h.http('GET', '/v1/contacts')).json.contacts as import('@flex/protocol').ContactRecord[]).find(
    (c) => c.name === 'Aradhya',
  )!;
  const same = await patch(c.id, { name: 'Ari', address: c.address, chain_ids: c.chain_ids, version: c.version });
  expect(same.json().ens_name).toBe('alice.eth');
  const updated = await patch(c.id, {
    name: 'Ari',
    address: addr(60),
    chain_ids: [11155111],
    version: same.json().version,
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ ens_name: null, chain_ids: [11155111] });
  expect(h.repos.db2.findByEnsName('alice.eth')).toEqual([]);
  expect(
    (
      await patch(updated.json().id, {
        name: 'Ari Again',
        address: addr(60),
        chain_ids: [11155111],
        version: updated.json().version,
      })
    ).statusCode,
  ).toBe(200);
});
it('rolls back every change when a network insertion fails', async () => {
  h = await harness('A-01');
  const c = ((await h.http('GET', '/v1/contacts')).json.contacts as import('@flex/protocol').ContactRecord[]).find(
    (c) => c.name === 'Aradhya',
  )!;
  const before = h.repos.db2.listAll();
  h.db.exec(
    "CREATE TRIGGER reject_contact_network BEFORE INSERT ON db2_address_book BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  expect(
    (await patch(c.id, { name: 'Changed', address: addr(62), chain_ids: [11155111], version: c.version })).statusCode,
  ).toBe(500);
  expect(h.repos.db2.listAll()).toEqual(before);
});
it('pages identities and rejects invalid pagination', async () => {
  h = await harness('A-01');
  const first = await h.http('GET', '/v1/contacts?limit=1');
  expect(first.json).toMatchObject({ total: 2, limit: 1, offset: 0, next_offset: 1 });
  const second = await h.http('GET', '/v1/contacts?limit=1&offset=1');
  expect(second.json).toMatchObject({ total: 2, next_offset: null });
  expect(second.json.contacts).not.toEqual(first.json.contacts);
  for (const query of ['limit=101', 'offset=-1', 'limit=1.5', 'token=USDC'])
    expect((await h.http('GET', `/v1/contacts?${query}`)).status).toBe(400);
});
for (const editKind of ['address', 'name', 'networks'] as const) {
  it(`keeps an ENS question bound to its displayed saved address after a ${editKind} edit`, async () => {
    h = await harness('A-25');
    const { BASE, ARB, coinType } = await import('./harness.js');
    h.addContact('Riya', addr(0xe1), [BASE, ARB], 'riya.eth');
    h.ens.set('riya.eth', coinType(BASE), addr(0xe2)).set('riya.eth', coinType(ARB), addr(0xe2));
    const question = await h.say('send 10 usdc to riya');
    expect(question.body.question?.code).toBe('Q_ENS_CHANGED');
    const c = ((await h.http('GET', '/v1/contacts')).json.contacts as import('@flex/protocol').ContactRecord[]).find(
      (c) => c.name === 'Riya',
    )!;
    expect(
      (
        await patch(c.id, {
          name: editKind === 'name' ? 'Riya New' : c.name,
          address: editKind === 'address' ? addr(0xe3) : c.address,
          chain_ids: editKind === 'networks' ? [11155111] : c.chain_ids,
          version: c.version,
        })
      ).statusCode,
    ).toBe(200);
    const summary = await h.answer(question, { chipLabel: 'Keep saved address' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(JSON.stringify(h.exec.submissions[0]?.envelope)).toContain(addr(0xe1));
    expect(JSON.stringify(h.exec.submissions[0]?.envelope)).not.toContain(addr(0xe3));
  });
}
it('does not overwrite an edited contact through an older ENS question', async () => {
  h = await harness('A-25');
  const { BASE, ARB, coinType } = await import('./harness.js');
  h.addContact('Riya', addr(0xe1), [BASE, ARB], 'riya.eth');
  h.ens.set('riya.eth', coinType(BASE), addr(0xe2)).set('riya.eth', coinType(ARB), addr(0xe2));
  const question = await h.say('send 10 usdc to riya');
  const c = ((await h.http('GET', '/v1/contacts')).json.contacts as import('@flex/protocol').ContactRecord[]).find(
    (c) => c.name === 'Riya',
  )!;
  expect(
    (await patch(c.id, { name: c.name, address: addr(0xe3), chain_ids: c.chain_ids, version: c.version })).statusCode,
  ).toBe(200);
  const response = await h.answer(question, { chipLabel: 'Use new address' });
  expect(response.body.state).toBe('done');
  expect(response.body.summary).toBeUndefined();
  expect(response.body.messages.map((m) => m.text).join(' ')).toContain('contact changed');
  expect(h.repos.db2.findByNameKey('riya').every((row) => row.address.toLowerCase() === addr(0xe3).toLowerCase())).toBe(
    true,
  );
  expect(h.exec.submissions).toHaveLength(0);
});
