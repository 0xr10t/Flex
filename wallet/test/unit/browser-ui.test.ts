// Exercise the served script with a small DOM/provider fixture. No extension, RPC, signatures or broadcasts.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { permissionRequestFor } from '../../src/autopay/permission.js';
import { ALEX, BASE, BOB, WALLET, autopay, envelope, payEth } from '../support/envelopes.js';

class Element {
  children: Element[] = [];
  textContent = '';
  disabled = false;
  dataset: Record<string, string> = {};
  handlers = new Map<string, () => Promise<void>>();
  constructor(readonly tagName = 'div') {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  setAttribute() {}
  addEventListener(name: string, fn: () => Promise<void>) {
    this.handlers.set(name, fn);
  }
  async click() {
    expect(this.disabled).toBe(false);
    await this.handlers.get('click')?.();
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  text(): string {
    return [this.textContent, ...this.children.map((child) => child.text())].join(' ');
  }
}

async function browser({ focused = false, unrelated = false } = {}) {
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const e = envelope([payEth(0, [[ALEX, '0.01']])]);
  const setup = { requestId: e.request_id, step: 0, chainId: BASE, intent: e.intents[0] };
  const other = envelope([payEth(0, [[BOB, '0.02']])]);
  const otherSetup = { requestId: other.request_id, step: 0, chainId: BASE, intent: other.intents[0] };
  let upgraded = false;
  let pending = true;
  const providerCalls: string[] = [];
  const apiCalls: { url: string; body: unknown }[] = [];
  const state = () => ({
    wallet: WALLET,
    chainIds: [BASE],
    feeMaxEth: '0.003',
    upgrades: [...(pending ? [setup] : []), ...(unrelated ? [otherSetup] : [])],
    requests: pending
      ? [{ id: e.request_id, steps: [{ step: 0, status: 'pending', error: 'BROWSER_ACCOUNT_UPGRADE_REQUIRED' }] }]
      : [],
    delegations: [],
    batches: [],
  });
  const provider = {
    isMetaMask: true,
    async request({ method }: { method: string }) {
      providerCalls.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [WALLET];
      if (method === 'eth_chainId') return `0x${BASE.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') return null;
      throw new Error(`Unexpected provider method: ${method}`);
    },
  };
  runInNewContext(readFileSync(new URL('../../src/browser/ui.js', import.meta.url), 'utf8'), {
    document: {
      getElementById: get,
      createElement: (name: string) => new Element(name),
      body: { classList: { toggle: vi.fn() } },
    },
    window: { ethereum: provider, location: { hash: focused ? `#approve=${e.request_id}` : '', reload: vi.fn() } },
    URL,
    URLSearchParams,
    setInterval: () => 0,
    fetch: async (url: string, options: { body?: string }) => {
      if (url === '/browser/state') return { ok: true, json: async () => state() };
      expect(url).toBe('/browser/account-upgrade');
      const body = JSON.parse(options.body!);
      apiCalls.push({ url, body });
      if (body.decision === 'check' && !upgraded)
        return { ok: false, json: async () => ({ error: 'BROWSER_ACCOUNT_UPGRADE_REQUIRED' }) };
      pending = false;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await vi.waitFor(() => expect(get('batches').text()).toContain('Enable your smart account on Base Sepolia'));
  const button = (label: string) => {
    const result = get('batches')
      .all()
      .find((node) => node.tagName === 'button' && node.textContent === label);
    expect(result).toBeDefined();
    return result!;
  };
  return {
    get,
    button,
    providerCalls,
    apiCalls,
    setup,
    upgrade: () => {
      upgraded = true;
    },
  };
}

describe('browser account setup flow', () => {
  it('shows the saved payment and guides setup, then checks the upgrade without requesting a signature', async () => {
    const b = await browser();
    expect(b.get('batches').text()).toContain(`0.01 ETH to ${ALEX}`);
    expect(b.get('batches').text()).toContain('Account details → Smart account');
    expect(b.get('batches').text()).toContain('payment still needs its own MetaMask approval');
    expect(b.get('requests').text()).not.toContain('checking route');
    expect(b.button('Check upgrade and continue').disabled).toBe(false);
    await b.button('Select Base Sepolia in MetaMask').click();
    expect(b.providerCalls[0]).toBe('eth_requestAccounts');
    expect(b.providerCalls).toContain('wallet_switchEthereumChain');
    expect(b.apiCalls).toEqual([]);
    await b.button('Check upgrade and continue').click();
    expect(b.get('notice').text()).toContain('Your payment is still saved');
    expect(b.get('batches').text()).toContain('Enable your smart account');
    b.upgrade();
    await b.button('Check upgrade and continue').click();
    expect(b.get('notice').text()).toContain('Account upgrade verified');
    expect(b.get('batches').text()).not.toContain('Enable your smart account');
    expect(b.apiCalls.map((call) => call.body)).toEqual([
      { requestId: b.setup.requestId, step: 0, decision: 'check' },
      { requestId: b.setup.requestId, step: 0, decision: 'check' },
    ]);
    expect(
      b.providerCalls.every((method) =>
        ['eth_accounts', 'eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId'].includes(method),
      ),
    ).toBe(true);
  });
  it('can cancel the saved payment without requesting a chain switch or transaction', async () => {
    const b = await browser();
    await b.button('Cancel payment').click();
    expect(b.apiCalls).toEqual([
      { url: '/browser/account-upgrade', body: { requestId: b.setup.requestId, step: 0, decision: 'cancel' } },
    ]);
    expect(b.providerCalls).toEqual([]);
    expect(b.get('batches').text()).not.toContain('Enable your smart account');
  });
  it('shows only the CLI-selected request and explains account setup without opening MetaMask automatically', async () => {
    const b = await browser({ focused: true, unrelated: true });
    expect(b.get('batches').text()).toContain(`0.01 ETH to ${ALEX}`);
    expect(b.get('batches').text()).not.toContain(BOB);
    expect(b.get('focus-status').text()).toContain('saved and waiting for account setup');
    expect(b.get('requests').text()).not.toContain('checking route');
    expect(b.providerCalls).toEqual([]);
    expect(b.apiCalls).toEqual([]);

    b.upgrade();
    await b.button('Check upgrade and continue').click();
    expect(b.providerCalls[0]).toBe('eth_requestAccounts');
    expect(b.apiCalls).toEqual([
      { url: '/browser/account-upgrade', body: { requestId: b.setup.requestId, step: 0, decision: 'check' } },
    ]);
    expect(b.get('batches').text()).not.toContain('Enable your smart account');
    expect(b.get('batches').text()).not.toContain(BOB);
    expect(b.providerCalls).not.toContain('wallet_sendCalls');
    expect(b.providerCalls).not.toContain('eth_signTypedData_v4');
  });
});

describe('recurring permission (F8)', () => {
  const k = autopay(0, 2_000_000_000, [[ALEX, '10']]);
  const permissionRequest = permissionRequestFor(k, WALLET, '0x00000000000000000000000000000000000e0ec0');
  const ID = `0x${'ab'.repeat(32)}`;

  /** The approval page with one pending permission; MetaMask answers with `answer`, the server with `server`. */
  async function page(answer: () => unknown, server: { ok: boolean; error?: string } = { ok: true }) {
    const nodes = new Map<string, Element>();
    const get = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id)!;
    };
    const asked: unknown[] = [];
    const posted: { url: string; body: unknown }[] = [];
    let pending = true;
    const provider = {
      isMetaMask: true,
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [WALLET];
        if (method === 'eth_chainId') return `0x${BASE.toString(16)}`;
        if (method === 'wallet_switchEthereumChain') return null;
        expect(method).toBe('wallet_requestExecutionPermissions');
        asked.push(params);
        return answer();
      },
    };
    runInNewContext(readFileSync(new URL('../../src/browser/ui.js', import.meta.url), 'utf8'), {
      document: {
        getElementById: get,
        createElement: (name: string) => new Element(name),
        body: { classList: { toggle: vi.fn() } },
      },
      window: { ethereum: provider, location: { hash: '', reload: vi.fn() } },
      URL,
      URLSearchParams,
      setInterval: () => 0,
      fetch: async (url: string, options: { body?: string }) => {
        if (url === '/browser/state')
          return {
            ok: true,
            json: async () => ({
              wallet: WALLET,
              chainIds: [BASE],
              feeMaxEth: '0.003',
              upgrades: [],
              requests: [],
              delegations: pending
                ? [{ id: ID, requestId: 'req_000000000001', step: 0, permissionRequest, intent: k }]
                : [],
              batches: [],
            }),
          };
        posted.push({ url, body: JSON.parse(options.body!) });
        if (url === '/browser/delegation' && !server.ok)
          return { ok: false, json: async () => ({ error: server.error }) };
        pending = false;
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    await vi.waitFor(() => expect(get('batches').text()).toContain('Approve recurring payment permission'));
    const review = get('batches')
      .all()
      .find((node) => node.tagName === 'button' && node.textContent === 'Review permission in MetaMask')!;
    return { get, asked, posted, review };
  }
  const refusal = (code: number) => () => {
    throw Object.assign(new Error('refused'), { code });
  };

  it('asks MetaMask for exactly the saved request and posts its answer', async () => {
    const response = { context: '0x1234' };
    const p = await page(() => [response]);
    expect(p.get('batches').text()).toContain('at most 10.05 USDC every day');
    await p.review.click();
    expect(p.asked).toEqual([[permissionRequest]]);
    expect(p.posted).toEqual([{ url: '/browser/delegation', body: { id: ID, response } }]);
    expect(p.get('notice').text()).toContain('Permission granted');
  });

  it('a rejection, or a refusal before MetaMask shows it, rejects the step', async () => {
    for (const [code, notice] of [
      [4001, 'Recurring permission rejected'],
      [4100, 'refused this request before showing it (4100)'],
    ] as const) {
      const p = await page(refusal(code));
      await p.review.click();
      expect(p.posted).toEqual([{ url: '/browser/reject-delegation', body: { id: ID } }]);
      expect(p.get('notice').text()).toContain(notice);
    }
  });

  it('a grant with other terms is kept pending and the user is told to revoke it', async () => {
    const p = await page(() => [{ context: '0x1234' }], { ok: false, error: 'PERMISSION_MISMATCH' });
    await p.review.click();
    expect(p.posted.map((c) => c.url)).toEqual(['/browser/delegation']);
    expect(p.get('notice').text()).toContain('Revoke that permission in MetaMask');
  });
});
