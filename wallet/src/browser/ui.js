/* global window, document, fetch, setInterval, setTimeout, URL, URLSearchParams */
const names = { 11155111: 'Ethereum Sepolia', 84532: 'Base Sepolia', 421614: 'Arbitrum Sepolia' };
// Public endpoints MetaMask uses only when the network is missing; the wallet's own RPC URLs never reach the page.
const rpcs = {
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.etherscan.io'],
  84532: ['https://sepolia.base.org', 'https://sepolia.basescan.org'],
  421614: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://sepolia.arbiscan.io'],
};
// Invalid params, unauthorized, unsupported method, capability or chain: MetaMask refused before submitting anything.
const REFUSED_BEFORE_SENDING = [-32602, 4100, 4200, 5700, 5710];
const $ = (id) => document.getElementById(id);
let state,
  provider,
  connected = false,
  sending = false,
  refreshing = false;
/**
 * Approval view: flexx opens this page as `#approve=<request id>` after you confirm a plan. The page then shows only
 * that request, with its details filled in, and opens MetaMask by itself as soon as each step has passed its checks.
 */
const focusId = (() => {
  const id = new URLSearchParams(window.location.hash.slice(1)).get('approve');
  return id && /^req_[0-9a-f]{12}$/.test(id) ? id : null;
})();
/** Steps this page has already opened MetaMask for (or refreshed), so a rejection never reopens it. */
const autoTried = new Set();
/** The focused request had something waiting on you or on MetaMask while this page was open. */
let focusWasOpen = false;
let closing = false;
const errors = {
  INVALID_BRIDGE: 'Choose two different testnets and enter a positive USDC amount with up to six decimals.',
  REFRESH_OR_RECOVER_BATCH:
    'Refresh this quote, or recover an existing approval. Another batch may still be pending on this chain.',
  TRANSACTION_NOT_MINED: 'MetaMask has submitted this transaction. Waiting for it to be mined.',
  TRANSACTION_DOES_NOT_MATCH:
    'The transaction does not match this exact atomic batch. Keep it pending and check the source transaction.',
  WALLET_RESULT_UNVERIFIED: 'The wallet result could not be verified. No new transfer will be started.',
  VERIFICATION_UNAVAILABLE: 'Chain verification is temporarily unavailable. The saved transfer remains pending.',
  BATCH_ALREADY_DISPATCHED: 'This batch already reached the wallet. Check its status; do not create a replacement.',
  BROWSER_ACCOUNT_UPGRADE_REQUIRED:
    'The account upgrade is not visible on this network yet. Complete it in MetaMask, wait for confirmation, then check again. Your payment is still saved.',
  ACCOUNT_DELEGATED_ELSEWHERE:
    'This account points to a different smart-account implementation. Flex has kept the payment paused.',
  UPGRADE_NOT_PENDING: 'This setup step has already changed. Refresh the wallet page to see its current state.',
  INVALID_UPGRADE_REQUEST: 'This setup request is invalid. Refresh the wallet page.',
  PERMISSION_MISMATCH:
    'MetaMask granted different terms than this plan asked for, so nothing was registered. Revoke that permission in MetaMask, then review it again.',
  PERMISSION_UNSUPPORTED_ACCOUNT:
    'MetaMask granted this permission for an account that is not deployed yet. Nothing was registered. Upgrade the account in MetaMask, then review it again.',
};
const notify = (message) => {
  $('notice').textContent = message;
};
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Flex-Wallet': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(errors[result.error] || result.error || 'Request unavailable.');
  return result;
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** `variant`: true for a secondary button, or 'approve' (green) / 'reject' (red). Default is the gold primary. */
function action(label, fn, variant = false) {
  const node = el('button', label, variant === true ? 'secondary' : variant || undefined);
  node.type = 'button';
  // approving connects MetaMask first when needed, so there is no separate connect step
  node.disabled = sending;
  node.addEventListener('click', async () => {
    notify('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      notify(e.message);
    }
  });
  return node;
}
function every(seconds) {
  for (const [unit, size] of [
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ])
    if (seconds % size === 0) return seconds === size ? `every ${unit}` : `every ${seconds / size} ${unit}s`;
  return `every ${seconds} seconds`;
}
function eth(wei, decimals = 18) {
  const s = BigInt(wei)
    .toString()
    .padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals).replace(/0+$/, '') || '0'}`;
}
/** Connects MetaMask to the configured wallet; throws when it can't. */
async function connect() {
  provider = window.ethereum?.providers?.find((p) => p.isMetaMask) ?? window.ethereum;
  if (!provider?.isMetaMask) throw new Error('Open this page in a browser with MetaMask installed.');
  const configured = (accounts) => accounts.some((a) => a.toLowerCase() === state.wallet.toLowerCase());
  let accounts = await provider.request({ method: 'eth_requestAccounts' });
  // A site already connected to another account gets no prompt, so ask MetaMask to choose accounts again.
  if (!configured(accounts)) {
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    accounts = await provider.request({ method: 'eth_accounts' });
  }
  connected = configured(accounts);
  notify('');
  $('connection').textContent = connected
    ? `Connected: ${state.wallet}`
    : `Choose this configured account in MetaMask: ${state.wallet}`;
  $('connect').textContent = connected ? 'Connected to MetaMask' : 'Connect MetaMask';
  $('connect').dataset.connected = String(connected);
  render();
  if (!connected) throw new Error(`Choose the configured account in MetaMask: ${state.wallet}`);
}
async function ensureConnected() {
  if (!connected) await connect();
}
async function accountCheck(chainId) {
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (!accounts.some((a) => a.toLowerCase() === state.wallet.toLowerCase()))
    throw new Error('Connect the configured wallet first.');
  const chain = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain }] });
  } catch (e) {
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw e;
    const [rpc, explorer] = rpcs[chainId];
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chain,
          chainName: names[chainId],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [rpc],
          blockExplorerUrls: [explorer],
        },
      ],
    });
  }
  const actual = await provider.request({ method: 'eth_chainId' });
  if (actual !== chain) throw new Error('The wallet is on a different network.');
  return chain;
}
const PENDING = 'This batch is still pending in MetaMask. Its saved ID will be used for recovery.';
async function track(batch, quiet = false) {
  try {
    const result = await provider.request({ method: 'wallet_getCallsStatus', params: [batch.walletId || batch.id] });
    if (result.receipts?.length) {
      await api('/browser/receipt', { id: batch.id, result });
      if ($('notice').textContent === PENDING) notify('');
    } else if (!quiet) notify(PENDING);
  } catch (e) {
    if (!quiet)
      notify(
        e.code === 5730
          ? 'MetaMask has no result for this batch yet. Keep it pending, or recover with its source transaction hash.'
          : e.message,
      );
  }
}
async function send(batch) {
  if (sending) return;
  sending = true;
  render();
  let claimed = false;
  try {
    await ensureConnected();
    const chainId = await accountCheck(batch.chainId);
    const capabilities = await provider.request({
      method: 'wallet_getCapabilities',
      params: [state.wallet, [chainId]],
    });
    if (!['ready', 'supported'].includes(capabilities[chainId]?.atomic?.status))
      throw new Error(
        'This account or network does not support atomic batches in MetaMask. No transfer has been submitted.',
      );
    const prepared = await api('/browser/claim', { id: batch.id });
    claimed = true;
    notify('Review the amount, approval, CCIP fee and any account upgrade in MetaMask.');
    const result = await provider.request({ method: 'wallet_sendCalls', params: [prepared.calls] });
    const walletId = typeof result === 'string' ? result : (result.id ?? result.batchId);
    await api('/browser/wallet-id', { id: batch.id, walletId });
    batch.walletId = walletId;
    await track(batch);
  } catch (e) {
    if (claimed && [4001, 5750].includes(e.code)) {
      await api('/browser/reject', { id: batch.id });
      notify('You rejected this batch in MetaMask. No replacement was started.');
    } else if (claimed && REFUSED_BEFORE_SENDING.includes(e.code)) {
      await api('/browser/reject', { id: batch.id });
      notify(`MetaMask refused this request before sending it (${e.code}). Nothing was submitted.`);
    } else if (claimed && e.code === 5720) await track(batch);
    else
      notify(
        typeof e.code === 'number'
          ? 'MetaMask could not complete the request. Check its activity; a dispatched batch stays saved for recovery.'
          : e.message,
      );
  } finally {
    sending = false;
    await refresh();
  }
}
async function requestPermission(request) {
  if (sending) return;
  sending = true;
  render();
  let response;
  try {
    await ensureConnected();
    await accountCheck(Number(request.permissionRequest.chainId));
    [response] = await provider.request({
      method: 'wallet_requestExecutionPermissions',
      params: [request.permissionRequest],
    });
    await api('/browser/delegation', { id: request.id, response });
    notify('Permission granted. Review the separate registration transaction next. CRE is running in simulation mode.');
  } catch (e) {
    const refused = REFUSED_BEFORE_SENDING.includes(e.code);
    if (!response && (e.code === 4001 || refused)) await api('/browser/reject-delegation', { id: request.id });
    notify(
      e.code === 4001
        ? 'Recurring permission rejected. Nothing was registered.'
        : refused
          ? `MetaMask refused this request before showing it (${e.code}). Nothing was registered.`
          : response
            ? e.message
            : 'Permission approval could not be saved. Refresh and try again; no registration was sent.',
    );
  } finally {
    sending = false;
    await refresh();
  }
}
async function checkAccountUpgrade(request) {
  if (sending) return;
  sending = true;
  render();
  try {
    await ensureConnected();
    await accountCheck(request.chainId);
    await api('/browser/account-upgrade', { requestId: request.requestId, step: request.step, decision: 'check' });
    notify('Account upgrade verified. Rechecking the saved payment; review it in MetaMask when it is ready.');
  } finally {
    sending = false;
    await refresh();
  }
}
function accountSetup(request) {
  const chain = names[request.chainId] || `chain ${request.chainId}`;
  const card = el('article', undefined, 'card');
  card.append(el('h3', `Enable your smart account on ${chain}`));
  const intent = request.intent;
  const facts = slipFor(intent, request.chainId);
  if (facts) card.append(facts);
  card.append(el('p', 'Your payment is saved and waiting for account setup.'));
  const steps = el('ol');
  for (const instruction of [
    `In MetaMask, select this account: ${state.wallet}.`,
    `Open the account menu (three dots), then Account details → Smart account. Enable ${chain}.`,
    'Review and approve the account upgrade in MetaMask. It costs test ETH for network gas.',
    'After it confirms, return here and check the upgrade. Your payment still needs its own MetaMask approval.',
  ])
    steps.append(el('li', instruction));
  const help = el('a', 'MetaMask account setup guide');
  help.href = 'https://support.metamask.io/configure/accounts/switch-to-or-revert-from-a-smart-account/';
  help.target = '_blank';
  help.rel = 'noopener noreferrer';
  card.append(steps, help);
  const actions = el('div', undefined, 'actions');
  actions.append(
    action(
      `Select ${chain} in MetaMask`,
      async () => {
        await ensureConnected();
        await accountCheck(request.chainId);
        notify(`Open MetaMask → account menu → Account details → Smart account, and enable ${chain}.`);
      },
      true,
    ),
    action('Check upgrade and continue', () => checkAccountUpgrade(request)),
    action(
      'Cancel payment',
      () =>
        api('/browser/account-upgrade', {
          requestId: request.requestId,
          step: request.step,
          decision: 'cancel',
        }),
      'reject',
    ),
  );
  card.append(actions);
  return card;
}
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** A link to a transaction on the chain's block explorer; plain text when the chain or hash is unknown. */
function txLink(text, chainId, hash) {
  const explorer = rpcs[chainId]?.[1];
  if (!explorer || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return el('p', `${text}: ${hash}`, 'muted');
  const link = el('a', `${text} on ${new URL(explorer).hostname} ↗`);
  link.href = `${explorer}/tx/${hash}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const wrap = el('p');
  wrap.append(link);
  return wrap;
}
const span = (text, className) => el('span', text, className);
/**
 * An address in groups of four, with the first and last groups emphasised: the parts people compare against MetaMask.
 * The groups are spaced by CSS, so copying it still gives the exact address.
 */
function address(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? '')) return el('code', value ?? 'unknown', 'addr');
  const node = el('code', undefined, 'addr');
  node.title = value;
  const groups = value.slice(2).match(/.{4}/g);
  groups.forEach((group, i) =>
    node.append(span(i ? group : `0x${group}`, i === 0 || i === groups.length - 1 ? 'key' : undefined)),
  );
  return node;
}
/** Exact sum of decimal amount strings (no floating point). */
function total(values) {
  const places = Math.max(0, ...values.map((v) => (v.split('.')[1] ?? '').length));
  const sum = values.reduce((acc, v) => {
    const [whole, frac = ''] = v.split('.');
    return acc + BigInt(whole + frac.padEnd(places, '0'));
  }, 0n);
  if (!places) return sum.toString();
  const digits = sum.toString().padStart(places + 1, '0');
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '');
}
const network = (chainId) => names[chainId] || `chain ${chainId}`;
/**
 * The facts to check before saying yes: how much, from which account, to whom, on which network, and what it costs.
 * `rows` are [term, ...nodes]; `verify` adds the reminder to compare the highlighted characters with MetaMask.
 */
function slip({ label, amount, token, rows, note, verify }) {
  const box = el('section', undefined, 'slip');
  box.setAttribute('aria-label', 'Check these details');
  const head = el('div', undefined, 'slip-amount');
  head.append(span(label, 'slip-label'), el('strong', amount, 'figure'), span(token, 'unit'));
  const list = el('dl');
  for (const [term, ...values] of rows) {
    const row = el('div', undefined, 'row');
    const value = el('dd');
    value.append(...values);
    row.append(el('dt', term), value);
    list.append(row);
  }
  box.append(head, list);
  if (note) box.append(el('p', note, 'slip-note'));
  if (verify)
    box.append(el('p', 'Approve only if the highlighted characters match what MetaMask shows.', 'slip-check'));
  return box;
}
const yourWallet = () => [address(state.wallet), span('Your wallet', 'tag')];
const payees = (intent, suffix = '') =>
  intent.recipients.map((r) =>
    intent.recipients.length === 1
      ? ['To', address(r.recipient)]
      : ['To', span(`${r.amount.value} ${intent.token}${suffix}`, 'each'), address(r.recipient)],
  );
/** The verification slip for a step, or null when it moves no money (cancelling a plan). */
function slipFor(intent, chainId, { feeWei, verify = false } = {}) {
  if (intent?.intent_id === 'i')
    return slip({
      label: intent.recipients.length === 1 ? 'You send' : `You send in total, to ${intent.recipients.length} people`,
      amount: total(intent.recipients.map((r) => r.amount.value)),
      token: intent.token,
      rows: [
        ['From', ...yourWallet()],
        ...payees(intent),
        ['Network', span(network(intent.chain_id ?? chainId), 'chain')],
        ['Network fee', span('Paid in test ETH. MetaMask shows the exact amount.')],
      ],
      note: intent.depends_on?.length ? 'Runs after the transfer between your chains above has arrived.' : undefined,
      verify,
    });
  if (intent?.intent_id === 'j')
    return slip({
      label: 'You move',
      amount: intent.amount.value,
      token: 'USDC',
      rows: [
        ['From', ...yourWallet(), span(network(intent.source_chain_id), 'chain')],
        ['To', ...yourWallet(), span(network(intent.dest_chain_id), 'chain')],
        [
          'CCIP fee',
          span(
            feeWei
              ? `${eth(feeWei)} test ETH quoted, at most ${intent.fee_max_eth}`
              : `At most ${intent.fee_max_eth} test ETH`,
          ),
        ],
      ],
      note: 'Arrives at your own wallet. Network gas is extra and shown in MetaMask.',
      verify,
    });
  if (intent?.intent_id === 'k')
    return slip({
      label: 'Each run sends',
      amount: total(intent.recipients.map((r) => r.amount.value)),
      token: intent.token,
      rows: [
        ['From', ...yourWallet()],
        ...payees(intent, ' per run'),
        ['Executor fee', span(`${intent.fee.amount.value} ${intent.token} per run to`), address(intent.fee.to)],
        [
          'Schedule',
          span(
            `${intent.schedule.max_runs} runs, ${every(intent.schedule.interval_seconds)}, from ${new Date(intent.schedule.start_at * 1000).toLocaleString()}`,
          ),
        ],
        ['Total cap', span(`${intent.limits.max_total.value} ${intent.token}`, 'strong')],
        ['Network', span(network(intent.chain_id ?? chainId), 'chain')],
      ],
      verify,
    });
  return null;
}
/** What a step does, in words, from the request the agent sent. */
function describe(intent, chainId) {
  if (intent?.intent_id === 'i')
    return intent.recipients.length === 1
      ? `Send ${intent.recipients[0].amount.value} ${intent.token} to ${short(intent.recipients[0].recipient)}`
      : `Pay ${intent.recipients.length} recipients in ${intent.token}`;
  if (intent?.intent_id === 'j')
    return `Move ${intent.amount.value} USDC · ${names[intent.source_chain_id]} → ${names[intent.dest_chain_id]}`;
  if (intent?.intent_id === 'k') return `Register recurring payment on ${names[chainId]}`;
  if (intent?.intent_id === 'l') return `Cancel recurring payment on ${names[chainId]}`;
  return `Payment on ${names[chainId]}`;
}
/** In the approval view, only the request flexx opened the page for. */
const inFocus = (requestId) => !focusId || requestId === focusId;
function renderFocus() {
  document.body.classList.toggle('focus', Boolean(focusId));
  if (!focusId) return;
  const batches = state.batches.filter((b) => b.requestId === focusId);
  const delegations = (state.delegations ?? []).filter((d) => d.requestId === focusId);
  const upgrades = (state.upgrades ?? []).filter((u) => u.requestId === focusId);
  const request = state.requests.find((r) => r.id === focusId);
  if (upgrades.length) {
    $('focus-status').textContent =
      'Your payment is saved and waiting for account setup. Follow the steps below, then check the upgrade.';
    return;
  }
  const done = batches.length > 0 && batches.every((b) => ['executed', 'failed'].includes(b.stepStatus));
  const waiting = batches.some((b) => b.status === 'draft' && !['executed', 'failed'].includes(b.stepStatus));
  // the automatic MetaMask prompt has been used (or failed): from here the button does it
  const tried =
    batches.some((b) => autoTried.has(`b:${b.id}:${b.createdMs}`)) ||
    delegations.some((d) => autoTried.has(`d:${d.id}`));
  $('focus-status').textContent = done
    ? batches.every((b) => b.stepStatus === 'executed')
      ? 'Done. Every step was approved and verified.'
      : 'This request stopped. See the step below.'
    : waiting || delegations.length
      ? sending
        ? 'Approve the request in MetaMask. Its details are below.'
        : tried
          ? 'Press Approve in MetaMask below when you are ready.'
          : 'Opening MetaMask to approve the request below…'
      : batches.length
        ? 'Waiting for MetaMask and the chain to confirm.'
        : request
          ? 'Checking the route, fee and simulation. MetaMask opens as soon as it is ready.'
          : 'This request has not reached the wallet yet. It appears here as soon as it does.';
}
/** In the approval view, opens MetaMask by itself for the next step that is ready, once per step. */
async function autoApprove() {
  if (!focusId || sending || !state) return;
  for (const request of (state.delegations ?? []).filter((d) => d.requestId === focusId)) {
    if (autoTried.has(`d:${request.id}`)) continue;
    autoTried.add(`d:${request.id}`);
    return requestPermission(request);
  }
  for (const batch of state.batches.filter((b) => b.requestId === focusId && b.status === 'draft')) {
    if (['executed', 'failed'].includes(batch.stepStatus)) continue;
    const key = `b:${batch.id}:${batch.createdMs}`;
    if (autoTried.has(key)) continue;
    autoTried.add(key);
    // a quote older than a minute is checked again first; the refreshed step opens MetaMask on the next poll
    if (batch.expired) return api('/browser/refresh', { id: batch.id }).catch((e) => notify(e.message));
    return send(batch);
  }
}
function render() {
  if (!state) return;
  renderFocus();
  $('prepare').disabled = !connected || sending;
  $('ceiling').textContent = `CCIP fee ceiling: ${state.feeMaxEth} test ETH. Network gas is additional.`;
  const container = $('batches');
  // Polling must not erase a transaction hash while the user types, or collapse their call review.
  if (container.querySelector('input:focus')) return;
  const expanded = new Set([...container.querySelectorAll('details[open]')].map((d) => d.dataset.batchId));
  container.replaceChildren();
  const upgrades = (state.upgrades ?? []).filter((u) => inFocus(u.requestId));
  const delegations = (state.delegations ?? []).filter((d) => inFocus(d.requestId));
  for (const request of upgrades) container.append(accountSetup(request));
  for (const request of delegations) {
    const card = el('article', undefined, 'card');
    const intent = request.intent;
    card.append(el('h3', 'Approve recurring payment permission'));
    card.append(slipFor(intent, request.chainId ?? intent.chain_id, { verify: true }));
    card.append(
      el(
        'p',
        `MetaMask shows this as a token subscription: at most ${eth(request.permissionRequest.permission.data.periodAmount, intent.token === 'ETH' ? 18 : 6)} ${intent.token} ${every(intent.schedule.interval_seconds)}, ending after the last run. Only the Flex executor can use it, and only for the recipients above, which registration (a separate wallet transaction) fixes onchain. Local CRE simulation does not send scheduled payments.`,
      ),
    );
    const decide = el('div', undefined, 'actions');
    decide.append(
      action('Review permission in MetaMask', () => requestPermission(request), 'approve'),
      action(
        'Reject permission',
        async () => {
          await api('/browser/reject-delegation', { id: request.id });
          notify('Recurring permission rejected. Nothing was registered.');
        },
        'reject',
      ),
    );
    card.append(decide);
    container.append(card);
  }
  const queued = state.requests.filter((r) => inFocus(r.id) && !state.batches.some((b) => b.requestId === r.id));
  const pending = queued.filter((r) =>
    r.steps.some((s) => !['executed', 'failed'].includes(s.status) && s.error !== 'BROWSER_ACCOUNT_UPGRADE_REQUIRED'),
  );
  // Newest first; older stopped checks drop off instead of piling up.
  const stopped = queued.filter((r) => r.steps.some((s) => s.status === 'failed')).slice(0, 3);
  $('requests').replaceChildren();
  if (pending.length)
    $('requests').append(el('p', `${pending.length} request(s) checking route, fee and simulation agreement…`));
  const stopReasons = {
    BROWSER_ACCOUNT_UPGRADE_REQUIRED:
      'This account needs the MetaMask smart-account upgrade on this testnet before Flex can prepare the transfer. Upgrade the account in MetaMask, then submit a new plan.',
    SIMULATION_UNAVAILABLE:
      'The configured testnet RPC could not simulate this transfer. Check the executor RPC configuration, then submit a new plan.',
  };
  for (const request of stopped)
    $('requests').append(
      el(
        'p',
        `${stopReasons[request.steps.find((s) => s.status === 'failed').error] || `Transfer checks stopped: ${request.steps.find((s) => s.status === 'failed').error || 'unavailable'}.`} No wallet approval was requested.`,
      ),
    );
  const shown = state.batches.filter((b) => inFocus(b.requestId));
  if (!shown.length && !upgrades.length && !delegations.length && !focusId)
    container.append(el('p', 'Your prepared transfers will appear here.', 'muted'));
  for (const batch of shown) {
    const card = el('article', undefined, 'card');
    const intent = batch.intent;
    card.append(el('h3', describe(intent, batch.chainId)));
    const facts = slipFor(intent, batch.chainId, {
      feeWei: batch.feeWei,
      verify: batch.status === 'draft' && !batch.expired,
    });
    if (facts) card.append(facts);
    const complete = ['executed', 'failed'].includes(batch.stepStatus);
    const label =
      batch.stepStatus === 'executed'
        ? intent?.intent_id === 'k'
          ? 'Recurring plan registered. Local CRE only simulates scheduled runs.'
          : intent?.intent_id === 'l'
            ? 'Plan cancelled and permission revoked'
            : 'Delivered and verified'
        : batch.stepStatus === 'failed'
          ? `Stopped: ${batch.errorCode || 'check wallet activity'}`
          : batch.tracking === 'destination_unfinalized'
            ? 'Delivered on destination. Waiting for destination-chain finality before marking verified.'
            : batch.tracking === 'destination_failed'
              ? 'Destination execution failed. The transfer remains tracked.'
              : batch.delayed
                ? 'Delivery delayed. Still tracking; no second send.'
                : batch.tracking
                  ? batch.tracking === 'source_unfinalized'
                    ? 'Source confirmed. Waiting for source-chain finality.'
                    : batch.tracking === 'in_transit'
                      ? 'Waiting for verified, finalized delivery on the destination chain.'
                      : `Tracking: ${batch.tracking.replaceAll('_', ' ')}`
                  : batch.status === 'draft'
                    ? batch.expired
                      ? 'Quote expired · refresh to check again'
                      : 'Checked · ready for your review'
                    : batch.txHash
                      ? 'Source confirmed. Waiting for source-chain finality.'
                      : 'Waiting for MetaMask / source confirmation';
    // A payment on one chain has no "source": say plainly that it is on-chain and what is left.
    const sameChain = intent?.intent_id !== 'j';
    card.append(
      el(
        'p',
        sameChain && label === 'Source confirmed. Waiting for source-chain finality.'
          ? `Sent and confirmed on ${names[batch.chainId] || `chain ${batch.chainId}`}. Flex marks it verified once the block is final.`
          : sameChain && label === 'Waiting for MetaMask / source confirmation'
            ? 'Waiting for MetaMask and the network to confirm.'
            : label,
        `status ${batch.stepStatus === 'executed' ? 'ok' : batch.stepStatus === 'failed' ? 'bad' : 'live'}`,
      ),
    );
    if (batch.txHash) card.append(txLink('View transaction', batch.chainId, batch.txHash));
    if (batch.destinationTxHash && intent?.dest_chain_id)
      card.append(txLink('View destination transaction', intent.dest_chain_id, batch.destinationTxHash));
    if (intent?.intent_id === 'j' && intent.source_chain_id === 11155111 && !complete)
      card.append(
        el(
          'p',
          'Ethereum source finality typically takes 13–19 minutes. CCIP verification and destination finality follow.',
          'muted',
        ),
      );
    const details = el('details');
    details.dataset.batchId = batch.id;
    details.open = expanded.has(batch.id);
    details.append(el('summary', 'Review calls and recovery details'));
    for (const line of batch.summary) details.append(el('p', line, 'muted'));
    details.append(el('p', `Batch ID: ${batch.id}`, 'muted'));
    if (batch.walletId && batch.walletId !== batch.id)
      details.append(el('p', `MetaMask batch ID: ${batch.walletId}`, 'muted'));
    if (batch.txHash) details.append(el('p', `Source transaction: ${batch.txHash}`, 'muted'));
    if (batch.destinationTxHash)
      details.append(el('p', `Destination transaction: ${batch.destinationTxHash}`, 'muted'));
    card.append(details);
    if (batch.message?.message_id) {
      const link = el('a', 'View this message in CCIP Explorer');
      link.href = new URL(`/msg/${batch.message.message_id}`, 'https://ccip.chain.link').href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
    }
    if (!complete) {
      const actions = el('div', undefined, 'actions');
      if (batch.status === 'draft') {
        actions.append(
          action(
            batch.expired ? 'Refresh checks & quote' : 'Approve in MetaMask',
            () => (batch.expired ? api('/browser/refresh', { id: batch.id }) : send(batch)),
            batch.expired ? false : 'approve',
          ),
        );
        actions.append(action('Cancel', () => api('/browser/reject', { id: batch.id }), 'reject'));
      } else if (batch.status === 'dispatched') {
        actions.append(action('Check MetaMask status', () => track(batch), true));
        const recovery = el('form', undefined, 'recover');
        const hash = el('input');
        hash.placeholder = 'Source transaction hash (0x…)';
        hash.setAttribute('aria-label', 'Source transaction hash');
        const recover = action(
          'Recover by hash',
          () => api('/browser/recover', { id: batch.id, hash: hash.value.trim() }),
          true,
        );
        recovery.addEventListener('submit', (e) => e.preventDefault());
        recovery.append(hash, recover);
        details.append(recovery);
      }
      card.append(actions);
    }
    container.append(card);
  }
}
/**
 * True when nothing in the focused request needs this page any more: every step has finished, or its transaction is
 * back from MetaMask (the wallet follows it from there), or you rejected it.
 */
function focusSettled() {
  const request = state.requests.find((r) => r.id === focusId);
  if (!request || !request.steps.length) return false;
  return request.steps.every((s) => {
    if (['executed', 'failed', 'waiting'].includes(s.status)) return true;
    const batch = state.batches.find((b) => b.requestId === focusId && b.step === s.step);
    return batch?.status === 'received' || batch?.status === 'rejected';
  });
}
/** flexx follows the request from here, so the approval tab closes once you have decided on every step. */
function closeWhenDecided() {
  if (!focusId || closing) return;
  if (!focusSettled()) {
    focusWasOpen = true;
    return;
  }
  // A request that was already settled when the page opened stays on screen.
  if (!focusWasOpen) return;
  closing = true;
  notify('Done. flexx shows what happens next. Closing this tab…');
  setTimeout(() => {
    window.close();
    // Browsers only let a page close a tab it was opened into; otherwise say so.
    setTimeout(() => notify('Done. flexx shows what happens next. You can close this tab.'), 500);
  }, 1500);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/browser/state');
    render();
    if (connected && !sending)
      for (const batch of state.batches.filter((b) => b.status === 'dispatched')) await track(batch, true);
    void autoApprove();
    closeWhenDecided();
  } catch (e) {
    notify(e.message);
  } finally {
    refreshing = false;
  }
}
$('connect').addEventListener('click', async () => {
  try {
    await connect();
    notify('Connected. Choose a route and amount, then check the transfer.');
  } catch (e) {
    notify(typeof e.code === 'number' ? 'MetaMask connection was not completed.' : e.message);
  }
});
$('show-all').addEventListener('click', () => {
  window.location.hash = '';
  window.location.reload();
});
$('bridge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!connected || sending) return;
  $('prepare').disabled = true;
  try {
    await api('/browser/bridge', {
      sourceChainId: Number($('source').value),
      destChainId: Number($('dest').value),
      amount: $('amount').value.trim(),
    });
    notify('Checking the route, current fee and simulation agreement. Review the prepared transfer below.');
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    $('prepare').disabled = !connected || sending;
  }
});
async function init() {
  await refresh();
  if (!state) return;
  for (const chain of state.chainIds)
    for (const id of ['source', 'dest']) {
      const option = el('option', names[chain]);
      option.value = String(chain);
      $(id).append(option);
    }
  $('dest').selectedIndex = Math.min(1, state.chainIds.length - 1);
  $('connection').textContent = `Configured wallet: ${state.wallet}`;
  setInterval(refresh, 3000);
}
void init();
