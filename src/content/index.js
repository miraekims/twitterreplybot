// Content script entry. Bridges page-hook (MAIN world) to the background SW
// and bootstraps the modal UI.
(function () {
  'use strict';

  // Forward captured GraphQL traffic to the background.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.source !== 'xbot-page') return;
    if (data.type === 'graphql-seen' || data.type === 'hook-ready') {
      try {
        chrome.runtime.sendMessage({
          type: 'capture.observe',
          payload: { kind: data.type, data: data.payload },
        });
      } catch (_) {}
    }
    // fetch.res frames are handled per-request below (see relay.fetch).
  });

  // Relay: SW asks us to run a fetch in the page's MAIN world. We forward
  // to page-hook via window.postMessage and resolve when the matching
  // 'fetch.res' echoes back. See page-hook.js for the receiver.
  let _relaySeq = 0;
  function relayFetch({ url, init }) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++_relaySeq}`;
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'xbot-page' || d.type !== 'fetch.res' || d.id !== id) return;
        window.removeEventListener('message', onMsg);
        if (d.error) resolve({ error: d.error });
        else resolve({
          ok: d.ok, status: d.status, statusText: d.statusText,
          body: d.body, headers: d.headers,
        });
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'xbot-content', type: 'fetch.req', id, url, init }, '*');
      // Don't hang forever if the page-hook isn't there.
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ error: 'page-hook timeout (10s)' });
      }, 10000);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'relay.fetch') {
      relayFetch(msg.payload || {}).then((r) => sendResponse({ ok: true, data: r }));
      return true; // async
    }
    return false;
  });

  // Boot UI when DOM is ready (document_idle usually means it already is).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => XBotModal.init());
  } else {
    XBotModal.init();
  }
})();
