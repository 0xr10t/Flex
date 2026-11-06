/* global document, window, setInterval, localStorage, Event, fetch */
let state,
  provider,
  connected,
  busy = false;
const providers = [];
window.addEventListener('eip6963:announceProvider', (event) => {
  if (event.detail.info.rdns === 'io.metamask') providers.push(event.detail.provider);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const message = (text) => {
  document.querySelector('#message').textContent = text;
};
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-flex-setup': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Setup request failed');
  return value;
}
async function account(chainId) {
  provider ??= providers[0] ?? window.ethereum?.providers?.find((p) => p.isMetaMask) ?? window.ethereum;
  if (!provider) throw new Error('Open this page in the browser where MetaMask is installed.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  connected = accounts[0];
  if (connected?.toLowerCase() !== state.wallet.toLowerCase()) throw new Error(`Select ${state.wallet} in MetaMask.`);
  if (chainId)
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
  return connected;
}
async function act(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (error) {
    message(error.message || 'MetaMask request failed.');
  } finally {
    busy = false;
    await refresh();
  }
}
document.querySelector('#connect').onclick = () =>
  act(async () => {
    await account();
    message('Connected. Review each chain below.');
  });
function addButton(article, label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.disabled = busy;
  b.onclick = () => act(fn);
  article.append(b);
}
async function refresh() {
  try {
    state = await api('state');
    document.querySelector('#account').textContent = `Test wallet: ${state.wallet}`;
    const container = document.querySelector('#chains');
    container.replaceChildren();
    for (const chain of state.chains) {
      const card = document.createElement('article'),
        title = document.createElement('h2'),
        details = document.createElement('p');
      title.textContent = chain.name;
      card.append(title);
      details.textContent =
        chain.error ||
        `${chain.testEth} test ETH · ${chain.upgraded ? 'Smart account ready' : 'Smart account setup needed'}`;
      card.append(details);
      if (chain.error) {
        container.append(card);
        continue;
      }
      if (chain.executor) {
        const address = document.createElement('p');
        address.className = 'good';
        address.textContent = `Executor deployed: ${chain.executor}`;
        card.append(address);
      } else if (chain.pending || chain.failed) {
        const p = document.createElement('p');
        p.textContent = `${chain.failed ? 'Deployment failed; contact the operator before retrying.' : 'Deployment submitted; waiting for its receipt.'} ${chain.hash}`;
        card.append(p);
      } else {
        addButton(card, 'Deploy payment executor', async () => {
          await account(chain.chainId);
          const prepared = await api('prepare', { chainId: chain.chainId });
          message(`Review the ${chain.name} deployment in MetaMask. Estimated gas: ${prepared.estimatedEth} test ETH.`);
          let hash;
          try {
            hash = await provider.request({ method: 'eth_sendTransaction', params: [prepared.transaction] });
          } catch (error) {
            if (error.code === 4001) await api('rejected', { chainId: chain.chainId });
            throw error;
          }
          localStorage.setItem(`flex-cre-deploy:${state.wallet}:${chain.chainId}`, hash);
          await api('hash', { chainId: chain.chainId, hash });
          message(`Deployment submitted on ${chain.name}: ${hash}`);
        });
        const remembered = localStorage.getItem(`flex-cre-deploy:${state.wallet}:${chain.chainId}`);
        const input = document.createElement('input');
        input.placeholder = 'Recover a submitted deployment transaction hash';
        input.value = remembered || '';
        card.append(input);
        addButton(card, 'Recover hash', async () => {
          await api('hash', { chainId: chain.chainId, hash: input.value.trim() });
          message('Hash saved; checking the original deployment.');
        });
      }
      if (!chain.upgraded)
        addButton(card, 'Enable smart account', async () => {
          const from = await account(chain.chainId);
          message(
            `Approve MetaMask smart-account setup on ${chain.name}. The two calls send zero ETH to your own address.`,
          );
          await provider.request({
            method: 'wallet_sendCalls',
            params: [
              {
                version: '2.0.0',
                from,
                chainId: `0x${chain.chainId.toString(16)}`,
                atomicRequired: true,
                calls: [
                  { to: from, value: '0x0' },
                  { to: from, value: '0x0' },
                ],
              },
            ],
          });
          message('Smart-account request submitted. The page will verify the onchain code.');
        });
      container.append(card);
    }
  } catch (error) {
    message(error.message);
  }
}
void refresh();
setInterval(() => {
  if (!busy) void refresh();
}, 15000);
