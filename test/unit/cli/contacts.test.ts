import { expect, it, vi } from 'vitest';
import { Chat } from '../../../src/cli/chat.js';
import { Repl } from '../../../src/cli/repl.js';
import { createFrame, frameLines } from '../../../src/cli/render/frame.js';
import { AgentHttpError, type AgentApi } from '../../../src/cli/agent/client.js';
const type = (r: Repl, s: string) => {
  for (const char of s) r.handle({ kind: 'key', key: 'char', char });
};
function setup(
  options: {
    saveError?: Error;
    omitBase?: boolean;
    copy?: (text: string) => Promise<boolean>;
    paste?: () => Promise<string | undefined>;
  } = {},
) {
  let saved: unknown;
  const contact = {
    id: 1,
    name: 'Alice',
    address: '0x1111111111111111111111111111111111111111',
    chain_ids: [84532],
    ens_name: null,
    version: 'a'.repeat(64),
  };
  const api = {
    openSession: async () => 'ses_000000000001',
    health: async () => ({ ok: true, ollama: true, db: true }),
    listContacts: async () => ({
      contacts: [contact],
      total: 1,
      offset: 0,
      limit: 25,
      next_offset: null,
      networks: [
        ...(options.omitBase ? [] : [{ chain_id: 84532, name: 'Base Sepolia' }]),
        { chain_id: 11155111, name: 'Sepolia' },
      ],
    }),
    updateContact: async (_id: number, edit: object) => {
      if (options.saveError) throw options.saveError;
      saved = edit;
      return { ...contact, ...edit, version: 'b'.repeat(64) };
    },
  } as unknown as AgentApi;
  const chat = new Chat({
    connect: async () => ({
      baseUrl: 'http://127.0.0.1:8787',
      walletUrl: 'http://127.0.0.1:8788/',
      token: 'test',
      started: false,
      stop: () => undefined,
    }),
    client: () => api,
    timezone: 'UTC',
    openPage: () => false,
    copy: options.copy,
    paste: options.paste,
  });
  const onMessage = vi.fn(async () => []);
  const r = new Repl({ commands: chat.commands(), onMessage });
  const screen = () => {
    const f = createFrame(110, 30);
    r.drawConversation(f, { x: 2, y: 2, w: 104, h: 23 });
    return frameLines(f).join('\n');
  };
  return { r, chat, screen, onMessage, saved: () => saved };
}
it('opens in Read, edits only after toggling, and cancels without a save', async () => {
  const s = setup();
  expect(s.chat.commands().find((c) => c.name === 'contacts')).toBeDefined();
  type(s.r, '/contacts');
  s.r.handle({ kind: 'key', key: 'enter' });
  await s.r.idle();
  expect(s.screen()).toContain('Address book');
  expect(s.screen()).toContain('Alice');
  expect(s.screen()).toContain('[Read]');
  s.r.handle({ kind: 'key', key: 'paste', char: 'must not edit' });
  expect(s.saved()).toBeUndefined();
  type(s.r, 'e');
  s.r.handle({ kind: 'key', key: 'home', shift: true });
  s.r.handle({ kind: 'key', key: 'paste', char: 'Alicia' });
  expect(s.screen()).toContain('Alicia');
  s.r.handle({ kind: 'key', key: 'escape' });
  expect(s.screen()).toContain('[Read]');
  expect(s.screen()).not.toContain('Alicia');
  expect(s.saved()).toBeUndefined();
});
it('saves an edited contact explicitly and returns to Read mode', async () => {
  const s = setup();
  expect(s.chat.commands().find((c) => c.name === 'contacts')).toBeDefined();
  type(s.r, '/contacts');
  s.r.handle({ kind: 'key', key: 'enter' });
  await s.r.idle();
  s.screen();
  type(s.r, 'e');
  s.r.handle({ kind: 'key', key: 'home', shift: true });
  s.r.handle({ kind: 'key', key: 'paste', char: 'Alicia' });
  s.r.handle({ kind: 'key', key: 'save' });
  await s.r.idle();
  expect(s.saved()).toMatchObject({ name: 'Alicia', version: 'a'.repeat(64) });
  expect(s.screen()).toContain('[Read]');
});

async function open(s: ReturnType<typeof setup>) {
  type(s.r, '/contacts');
  s.r.handle({ kind: 'key', key: 'enter' });
  await s.r.idle();
  s.screen();
}
it('preserves the draft after a stale save and never sends editor text to chat', async () => {
  const s = setup({ saveError: new AgentHttpError(409, ['stale']) });
  await open(s);
  type(s.r, 'e');
  s.r.handle({ kind: 'key', key: 'home', shift: true });
  type(s.r, 'Alicia');
  s.r.handle({ kind: 'key', key: 'enter' });
  expect(s.saved()).toBeUndefined();
  s.r.handle({ kind: 'key', key: 'save' });
  await s.r.idle();
  expect(s.screen()).toContain('[Edit]');
  expect(s.screen()).toContain('Alicia');
  expect(s.screen()).toContain('Cancel and reload');
  expect(s.onMessage).not.toHaveBeenCalled();
});
it('supports mouse toggles, selection, network edits, and explicit Save', async () => {
  const s = setup();
  await open(s);
  const click = (needle: string) => {
    const lines = s.screen().split('\n');
    const y = lines.findIndex((line) => line.includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(needle);
    s.r.mouse({ kind: 'mouse', action: 'down', button: 0, col: x + 1, row: y + 1 });
  };
  click(' Edit ');
  expect(s.screen()).toContain('[Edit]');
  click('[ ] Sepolia');
  click('[Save Ctrl-S]');
  await s.r.idle();
  expect(s.saved()).toMatchObject({ chain_ids: [84532, 11155111] });
  expect(s.screen()).toContain('[Read]');
});
it('copies and cuts selected input only after clipboard success and safely pastes', async () => {
  const copy = vi.fn(async () => true);
  const s = setup({ copy, paste: async () => 'Alicia\nNew' });
  await open(s);
  s.r.handle({ kind: 'key', key: 'interrupt' });
  await s.r.idle();
  expect(copy).toHaveBeenLastCalledWith('0x1111111111111111111111111111111111111111');
  type(s.r, 'e');
  s.r.handle({ kind: 'key', key: 'home', shift: true });
  s.r.handle({ kind: 'key', key: 'cut' });
  await s.r.idle();
  expect(copy).toHaveBeenLastCalledWith('Alice');
  s.r.handle({ kind: 'key', key: 'clipboard-paste' });
  await s.r.idle();
  expect(s.screen()).toContain('Alicia New');
  expect(s.saved()).toBeUndefined();
  expect(s.onMessage).not.toHaveBeenCalled();
});
it('does not let a delayed paste overwrite a changed field', async () => {
  let resolve!: (value: string) => void;
  const s = setup({
    paste: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await open(s);
  type(s.r, 'e');
  s.r.handle({ kind: 'key', key: 'clipboard-paste' });
  type(s.r, 'x');
  resolve('old clipboard');
  await s.r.idle();
  expect(s.screen()).toContain('Alicex');
  expect(s.screen()).not.toContain('old clipboard');
});
it('ignores pasted edit shortcuts in Read mode and returns to chat on Escape', async () => {
  const s = setup();
  await open(s);
  s.r.handle({ kind: 'key', key: 'paste', char: 'e' });
  expect(s.screen()).toContain('[Read]');
  s.r.handle({ kind: 'key', key: 'escape' });
  expect(s.r.hasPanel).toBe(false);
  type(s.r, 'hello');
  s.r.handle({ kind: 'key', key: 'enter' });
  await s.r.idle();
  expect(s.onMessage).toHaveBeenCalledWith('hello');
});

it('shows unavailable saved networks so they can be explicitly removed', async () => {
  const s = setup({ omitBase: true });
  await open(s);
  type(s.r, 'e');
  expect(s.screen()).toContain('Unavailable network 84532');
  s.r.handle({ kind: 'key', key: 'tab' });
  s.r.handle({ kind: 'key', key: 'tab' });
  type(s.r, ' ');
  s.r.handle({ kind: 'key', key: 'tab' });
  type(s.r, ' ');
  s.r.handle({ kind: 'key', key: 'save' });
  await s.r.idle();
  expect(s.saved()).toMatchObject({ chain_ids: [11155111] });
});
