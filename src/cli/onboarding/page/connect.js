/* global window, document, fetch, URLSearchParams, setTimeout, Event */
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(window.location.hash.slice(1)).get('connect');
let announced,
  busy = false,
  finished = false,
  accounts = [];
const status = (text) => {
  $('status').textContent = text;
};
window.addEventListener('eip6963:announceProvider', (event) => {
  if (event.detail?.info?.rdns === 'io.metamask') announced = event.detail.provider;
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-flex-connect': token },
    body: JSON.stringify(body),
    credentials: 'omit',
  });
  if (!response.ok) throw new Error('The connection request expired. Return to Flexx and try again.');
}
async function save(address) {
  if (finished) return;
  await post('/connect', { address });
  finished = true;
  $('connect').hidden = true;
  $('selection').hidden = true;
  $('cancel').hidden = true;
  status(`Connected: ${address}. Return to Flexx; you can close this tab.`);
}
async function connect() {
  if (busy || finished) return;
  if (!/^[0-9a-f]{64}$/.test(token ?? '')) {
    status('This connection link is invalid. Open Flexx to start again.');
    return;
  }
  busy = true;
  $('connect').disabled = true;
  try {
    const provider =
      announced ??
      window.ethereum?.providers?.find((p) => p.isMetaMask) ??
      (window.ethereum?.isMetaMask ? window.ethereum : undefined);
    if (!provider)
      throw new Error(
        'MetaMask is not available in this browser. Install it here, or open this connection link in a browser with MetaMask.',
      );
    status('Approve the connection in MetaMask.');
    const result = await provider.request({ method: 'eth_requestAccounts' });
    if (finished) return;
    accounts = [
      ...new Set(
        Array.isArray(result) ? result.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)) : [],
      ),
    ];
    if (!accounts.length) throw new Error('No account was shared. Connect MetaMask to continue.');
    if (accounts.length === 1) await save(accounts[0]);
    else {
      $('accounts').replaceChildren(
        ...accounts.map((address) => {
          const option = document.createElement('option');
          option.value = address;
          option.textContent = address;
          return option;
        }),
      );
      $('selection').hidden = false;
      $('connect').hidden = true;
      status('Choose which connected account Flexx should use.');
    }
  } catch (error) {
    status(
      error.code === 4001
        ? 'Connection declined. Click Connect MetaMask when you are ready.'
        : error.code === -32002
          ? 'A connection request is already waiting in MetaMask. Open the extension to continue.'
          : error.message,
    );
  } finally {
    busy = false;
    $('connect').disabled = finished;
  }
}
$('connect').addEventListener('click', connect);
$('use-account').addEventListener('click', async () => {
  if (busy || finished || !accounts.includes($('accounts').value)) return;
  busy = true;
  $('use-account').disabled = true;
  try {
    await save($('accounts').value);
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    $('use-account').disabled = false;
  }
});
$('cancel').addEventListener('click', async () => {
  if (finished) return;
  try {
    await post('/cancel', {});
    finished = true;
    status('Connection cancelled. Return to your terminal.');
  } catch (error) {
    status(error.message);
  }
  $('connect').disabled = true;
  $('use-account').disabled = true;
  $('cancel').disabled = true;
});
setTimeout(connect, 400);
