/* global window, document, fetch, setInterval, URL, URLSearchParams */
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
function action(label, fn, secondary = false) {
  const node = el('button', label, secondary ? 'secondary' : undefined);
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
function eth(wei) {
  const s = BigInt(wei).toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, '') || '0'}`;
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
async function signDelegation(request) {
  if (sending) return;
  sending = true;
  render();
  let signature;
  try {
    await ensureConnected();
    await accountCheck(request.typedData.domain.chainId);
    signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [
        state.wallet,
        JSON.stringify({
          ...request.typedData,
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
            ...request.typedData.types,
          },
        }),
      ],
    });
    await api('/browser/delegation', { id: request.id, signature });
    notify(
      'Permission approved. Review the separate registration transaction next. CRE is running in simulation mode.',
    );
  } catch (e) {
    if (e.code === 4001 && !signature) await api('/browser/reject-delegation', { id: request.id });
    notify(
      e.code === 4001
        ? 'Recurring permission rejected.'
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
  if (intent?.recipients)
    for (const recipient of intent.recipients)
      card.append(
        el(
          'p',
          `${recipient.amount.value} ${intent.token} to ${recipient.recipient}${intent.intent_id === 'k' ? ' per run' : ''}`,
        ),
      );
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
      true,
    ),
  );
  card.append(actions);
  return card;
}
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** What a step does, in words, from the request the agent sent: the heading and the filled-in details. */
function describe(intent, chainId) {
  if (intent?.intent_id === 'i') {
    const single = intent.recipients.length === 1;
    const heading = single
      ? `Send ${intent.recipients[0].amount.value} ${intent.token} to ${short(intent.recipients[0].recipient)}`
      : `Pay ${intent.recipients.length} recipients in ${intent.token}`;
    return {
      heading,
      lines: [
        ...(single
          ? [`Recipient: ${intent.recipients[0].recipient}`]
          : intent.recipients.map((r) => `${r.amount.value} ${intent.token} to ${r.recipient}`)),
        `Network: ${names[intent.chain_id] ?? names[chainId]}`,
        ...(intent.depends_on?.length ? ['Runs after the transfer between your chains above has arrived.'] : []),
      ],
    };
  }
  if (intent?.intent_id === 'j')
    return {
      heading: `Move ${intent.amount.value} USDC · ${names[intent.source_chain_id]} → ${names[intent.dest_chain_id]}`,
      lines: [`Arrives at your own wallet. CCIP fee at most ${intent.fee_max_eth} test ETH.`],
    };
  if (intent?.intent_id === 'k') return { heading: `Register recurring payment on ${names[chainId]}`, lines: [] };
  if (intent?.intent_id === 'l') return { heading: `Cancel recurring payment on ${names[chainId]}`, lines: [] };
  return { heading: `Payment on ${names[chainId]}`, lines: [] };
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
    return signDelegation(request);
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
    for (const recipient of intent.recipients)
      card.append(el('p', `${recipient.amount.value} ${intent.token} to ${recipient.recipient} per run`));
    card.append(
      el(
        'p',
        `Fee per run: ${intent.fee.amount.value} ${intent.token}. Maximum ${intent.schedule.max_runs} runs, ${every(intent.schedule.interval_seconds)}.`,
      ),
    );
    card.append(
      el(
        'p',
        `Starts ${new Date(intent.schedule.start_at * 1000).toLocaleString()}. Total cap: ${intent.limits.max_total.value} ${intent.token}.`,
      ),
    );
    card.append(
      el(
        'p',
        'This grants a bounded onchain permission. Registration is a separate wallet transaction. Local CRE simulation does not send scheduled payments.',
      ),
    );
    card.append(
      action('Review permission in MetaMask', () => signDelegation(request)),
      action(
        'Reject permission',
        async () => {
          await api('/browser/reject-delegation', { id: request.id });
          notify('Recurring permission rejected. Nothing was registered.');
        },
        true,
      ),
    );
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
    const about = describe(intent, batch.chainId);
    card.append(el('h3', about.heading));
    for (const line of about.lines) card.append(el('p', line, 'detail'));
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
    card.append(el('p', label));
    if (intent?.intent_id === 'j' && intent.source_chain_id === 11155111 && !complete)
      card.append(
        el(
          'p',
          'Ethereum source finality typically takes 13–19 minutes. CCIP verification and destination finality follow.',
          'muted',
        ),
      );
    if (batch.feeWei) card.append(el('p', `Quoted CCIP fee: ${eth(batch.feeWei)} test ETH`));
    if (intent?.intent_id === 'j') card.append(el('p', `Recipient: your wallet ${state.wallet}`, 'muted'));
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
          action(batch.expired ? 'Refresh checks & quote' : 'Approve in MetaMask', () =>
            batch.expired ? api('/browser/refresh', { id: batch.id }) : send(batch),
          ),
        );
        actions.append(action('Cancel', () => api('/browser/reject', { id: batch.id }), true));
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
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/browser/state');
    render();
    if (connected && !sending)
      for (const batch of state.batches.filter((b) => b.status === 'dispatched')) await track(batch, true);
    void autoApprove();
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
