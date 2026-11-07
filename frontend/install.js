/* global document, navigator, window, URL */
const command = document.querySelector('#command');
const copy = document.querySelector('#copy');
const notice = document.querySelector('#status');
const installer = new URL('./install.sh', window.location.href);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(installer.hostname);
// A plain URL stays bare like `curl -fsSL https://… | bash`; anything the shell could reinterpret is single-quoted.
const url = /^[\w:/.~%+=,@-]+$/.test(installer.href) ? installer.href : `'${installer.href.replaceAll("'", "'\\''")}'`;
const parts = [
  ['curl', 'tool'],
  [' -fsSL ', 'flag'],
  [url, 'url'],
  [' | ', 'pipe'],
  ['bash', 'tool'],
];

if (installer.protocol === 'https:' || (local && installer.protocol === 'http:')) {
  for (const [text, kind] of parts) {
    const span = document.createElement('span');
    span.className = kind;
    span.textContent = text;
    command.append(span);
  }
  copy.disabled = false;
} else {
  command.textContent = 'Open this page over HTTPS to get the install command.';
  notice.textContent = 'For a local preview, run npm run frontend:dev.';
}

let reset;
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(command.textContent);
    copy.classList.add('done');
    notice.textContent = 'Copied. Paste it into your terminal.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    command.focus();
    notice.textContent = 'Selected. Press Ctrl+C or ⌘C to copy.';
  }
  window.clearTimeout(reset);
  reset = window.setTimeout(() => {
    copy.classList.remove('done');
    notice.textContent = '';
  }, 2500);
});
