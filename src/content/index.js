// Content script entry. Bridges page-hook (MAIN world) to the background SW
// and bootstraps the modal UI.
(function () {
  'use strict';

  // Forward captured GraphQL traffic to the background.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.source !== 'xbot-page') return;
    try {
      chrome.runtime.sendMessage({
        type: 'capture.observe',
        payload: { kind: data.type, data: data.payload },
      });
    } catch (_) {}
  });

  // Boot UI when DOM is ready (document_idle usually means it already is).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => XBotModal.init());
  } else {
    XBotModal.init();
  }
})();
