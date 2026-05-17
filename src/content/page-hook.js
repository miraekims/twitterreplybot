// Runs in the page MAIN world. Patches fetch + XHR to observe X.com GraphQL traffic
// and forwards (queryId, operationName, headers, variables, features, body) to the
// content script via window.postMessage.
//
// We do NOT modify any requests, only observe.
(function () {
  'use strict';
  if (window.__XBOT_HOOK__) return;
  window.__XBOT_HOOK__ = true;

  const GQL_RE = /\/i\/api\/graphql\/([^\/?#]+)\/([^\/?#]+)/;

  function send(type, payload) {
    try {
      window.postMessage({ source: 'xbot-page', type, payload }, '*');
    } catch (_) {}
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => { out[k.toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(([k, v]) => { out[String(k).toLowerCase()] = v; });
      } else if (typeof h === 'object') {
        for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
      }
    } catch (_) {}
    return out;
  }

  function captureUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return {
        full: u.toString(),
        path: u.pathname,
        variables: u.searchParams.get('variables'),
        features: u.searchParams.get('features'),
        fieldToggles: u.searchParams.get('fieldToggles'),
      };
    } catch (_) { return null; }
  }

  function emit(rawUrl, method, headersObj, body) {
    const u = captureUrl(rawUrl);
    if (!u) return;
    const m = u.path.match(GQL_RE);
    if (!m) return;
    send('graphql-seen', {
      url: u.full,
      queryId: m[1],
      operationName: m[2],
      method: method || 'GET',
      headers: headersObj,
      variables: u.variables,
      features: u.features,
      fieldToggles: u.fieldToggles,
      body: typeof body === 'string' ? body : null,
    });
  }

  // --- fetch hook ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      let url = '';
      let method = (init && init.method) || 'GET';
      let headers = headersToObject(init && init.headers);
      let body = init && init.body;
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input === 'object') {
        url = input.url || '';
        method = method || input.method || 'GET';
        if (!Object.keys(headers).length) headers = headersToObject(input.headers);
      }
      if (url) emit(url, method, headers, body);
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  // --- XHR hook ---
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__xbot = { method, url, headers: {} };
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      if (this.__xbot) this.__xbot.headers[String(k).toLowerCase()] = v;
      return origSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        const x = this.__xbot;
        if (x && x.url) emit(x.url, x.method, x.headers, body);
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  send('hook-ready', { ts: Date.now() });
})();
