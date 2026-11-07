import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ADDRESS = '0x00000000000000000000000000000000000000AA';
const SECOND = '0x00000000000000000000000000000000000000bb';
class Element {
  textContent = '';
  value = '';
  disabled = false;
  hidden = false;
  children: Element[] = [];
  handlers = new Map<string, () => Promise<void>>();
  addEventListener(event: string, fn: () => Promise<void>) {
    this.handlers.set(event, fn);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    this.value = children[0]?.value ?? '';
  }
  async click() {
    expect(this.disabled).toBe(false);
    await this.handlers.get('click')?.();
  }
}

async function page(opts: { accounts?: string[]; rejected?: boolean; missing?: boolean; discovery?: boolean } = {}) {
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const calls: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  let reject = opts.rejected;
  const provider = {
    isMetaMask: true,
    async request({ method }: { method: string }) {
      calls.push(method);
      if (reject) {
        reject = false;
        throw { code: 4001 };
      }
      return opts.accounts ?? [ADDRESS];
    },
  };
  let announce: (event: unknown) => void;
  let boot!: () => Promise<void>;
  runInNewContext(readFileSync(new URL('../../../src/cli/onboarding/page/connect.js', import.meta.url), 'utf8'), {
    document: { getElementById: get, createElement: () => new Element() },
    window: {
      location: { hash: `#connect=${'a'.repeat(64)}` },
      ethereum: opts.missing || opts.discovery ? undefined : provider,
      addEventListener: (_event: string, fn: typeof announce) => {
        announce = fn;
      },
      dispatchEvent: () => {
        if (opts.discovery) announce({ detail: { info: { rdns: 'io.metamask' }, provider } });
      },
    },
    URLSearchParams,
    Event: class {},
    setTimeout: (fn: typeof boot) => {
      boot = fn;
    },
    fetch: async (path: string, opts: { body: string; headers: Record<string, string> }) => {
      expect(opts.headers['x-flex-connect']).toBe('a'.repeat(64));
      posts.push({ path, body: JSON.parse(opts.body) });
      return { ok: true };
    },
  });
  await boot();
  return { get, calls, posts };
}

describe('MetaMask connection page', () => {
  it('automatically requests only account access and submits a single selected public address', async () => {
    const p = await page();
    expect(p.calls).toEqual(['eth_requestAccounts']);
    expect(p.posts).toEqual([{ path: '/connect', body: { address: ADDRESS } }]);
    expect(p.get('status').textContent).toContain('Return to Flexx');
    expect(p.get('connect').hidden).toBe(true);
  });
  it('supports EIP-6963 discovery without window.ethereum', async () => {
    const p = await page({ discovery: true });
    expect(p.posts).toEqual([{ path: '/connect', body: { address: ADDRESS } }]);
  });
  it('asks which account to use when MetaMask shares multiple accounts', async () => {
    const p = await page({ accounts: [ADDRESS, SECOND] });
    expect(p.posts).toHaveLength(0);
    expect(p.get('selection').hidden).toBe(false);
    p.get('accounts').value = SECOND;
    await p.get('use-account').click();
    expect(p.posts).toEqual([{ path: '/connect', body: { address: SECOND } }]);
  });
  it('allows a declined request to be retried without persisting an address', async () => {
    const p = await page({ rejected: true });
    expect(p.posts).toHaveLength(0);
    expect(p.get('status').textContent).toContain('declined');
    await p.get('connect').click();
    expect(p.posts).toHaveLength(1);
  });
  it('explains a missing extension in the default browser and permits cancellation', async () => {
    const p = await page({ missing: true });
    expect(p.calls).toHaveLength(0);
    expect(p.get('status').textContent).toContain('not available in this browser');
    await p.get('cancel').click();
    expect(p.posts).toEqual([{ path: '/cancel', body: {} }]);
  });
});
