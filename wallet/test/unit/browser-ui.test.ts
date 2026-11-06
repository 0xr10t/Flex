// Exercise the served script with a small DOM/provider fixture. No extension, RPC, signatures or broadcasts.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { ALEX, BASE, WALLET, envelope, payEth } from '../support/envelopes.js';

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

async function browser() {
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const e = envelope([payEth(0, [[ALEX, '0.01']])]);
  const setup = { requestId: e.request_id, step: 0, chainId: BASE, intent: e.intents[0] };
  let upgraded = false;
  let pending = true;
  const providerCalls: string[] = [];
  const apiCalls: { url: string; body: unknown }[] = [];
  const state = () => ({
    wallet: WALLET,
    chainIds: [BASE],
    feeMaxEth: '0.003',
    upgrades: pending ? [setup] : [],
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
    document: { getElementById: get, createElement: (name: string) => new Element(name) },
    window: { ethereum: provider },
    URL,
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
    expect(b.button('Check upgrade and continue').disabled).toBe(true);
    await b.get('connect').click();
    await b.button('Select Base Sepolia in MetaMask').click();
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
    await b.get('connect').click();
    await b.button('Cancel payment').click();
    expect(b.apiCalls).toEqual([
      { url: '/browser/account-upgrade', body: { requestId: b.setup.requestId, step: 0, decision: 'cancel' } },
    ]);
    expect(b.providerCalls).toEqual(['eth_requestAccounts']);
    expect(b.get('batches').text()).not.toContain('Enable your smart account');
  });
});
