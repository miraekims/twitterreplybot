// Tiny options-page controller. Reads + writes bridge.settings, polls status.

const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => resolve(r || { ok: false, error: 'no response' }));
  });
}

async function loadSettings() {
  const r = await send('bridge.getSettings', {});
  if (r.ok) {
    $('url').value = r.data.url || '';
    $('token').value = r.data.token || '';
  }
}

async function refreshStatus() {
  const r = await send('bridge.getStatus', {});
  const el = $('status');
  if (!r.ok || !r.data) { el.textContent = 'No status yet.'; return; }
  const s = r.data;
  if (s.connected) {
    el.innerHTML = `<span class="ok">✓ Connected</span> as @${s.handle || '?'} ` +
                   `(ext v${s.extVersion || '?'}). Last update ${ageSec(s._updated)} sec ago.`;
  } else if (s.connecting) {
    el.innerHTML = `<span>… Connecting</span>`;
  } else {
    el.innerHTML = `<span class="bad">✗ Disconnected</span>` +
                   (s.lastError ? ` — ${escapeHtml(s.lastError)}` : '');
  }
}

function ageSec(ts) {
  if (!ts) return '?';
  return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('save').addEventListener('click', async () => {
  const url = $('url').value.trim();
  const token = $('token').value.trim();
  if (!/^wss?:\/\//.test(url)) {
    $('status').innerHTML = `<span class="bad">URL must start with ws:// or wss://</span>`;
    return;
  }
  if (token.length < 16) {
    $('status').innerHTML = `<span class="bad">Token should be at least 16 characters</span>`;
    return;
  }
  $('save').disabled = true;
  await send('bridge.setSettings', { url, token });
  $('save').disabled = false;
  // Wait a beat for the reconnect to finish before showing fresh status.
  setTimeout(refreshStatus, 800);
});

loadSettings();
refreshStatus();
setInterval(refreshStatus, 2000);
