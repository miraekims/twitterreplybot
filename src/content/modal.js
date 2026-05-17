// Modal UI. Lives in the isolated content-script world.
//
// Tabs:
//   - auto    : auto-reply campaign (keywords + templates → reply under crypto posts)
//   - comments: legacy single-post replies viewer (kept for later)
//   - status  : capture readiness + raw state
const XBotModal = (() => {
  const TWEET_ID_RE = /(?:status|statuses)\/(\d+)/;

  let root, modal, overlay, fab, statusDot, statusText;
  let activeTab = 'auto';
  let captureState = { ready: false, ops: {} };
  let autoState = { status: 'idle', sentInSession: 0 };
  let autoConfig = null;
  let pollHandle = null;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const k of Object.keys(attrs)) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }

  function open() { overlay.classList.add('open'); modal.classList.add('open'); refreshAll(); }
  function close() { overlay.classList.remove('open'); modal.classList.remove('open'); }

  function setActiveTab(name) {
    activeTab = name;
    root.querySelectorAll('.xbot-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    root.querySelectorAll('.xbot-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }

  // ---------- AUTO tab ----------
  function buildAutoPane() {
    const pane = el('div', { class: 'xbot-pane active', 'data-pane': 'auto' });

    const kwLabel = el('label', { class: 'xbot-label' }, 'Keywords (one per line — these go straight into X search)');
    const kwArea = el('textarea', {
      class: 'xbot-textarea',
      rows: '4',
      placeholder: 'gm\ngm degens\ngm all\n#crypto\n$BTC',
    });

    const tplLabel = el('label', { class: 'xbot-label' }, 'Reply templates (one per line — random pick per reply; supports {author}, {name})');
    const tplArea = el('textarea', {
      class: 'xbot-textarea',
      rows: '5',
      placeholder: 'gm fren\nGM! Have a great one\ngm @{author} 🫡',
    });

    // Filters row
    const fMinLikes = numInput('Min likes', 0);
    const fMaxAge = numInput('Max age (min)', 240);
    const fMinFollowers = numInput('Min followers', 0);
    const fLangs = textInput('Langs (comma) e.g. en,ru', '');
    const fSkipReplies = check('Skip replies', true);
    const fSkipRetweets = check('Skip retweets', true);
    const fSkipUrls = check('Skip posts with links', false);

    // Pacing row
    const pMin = numInput('Min delay (sec)', 25);
    const pMax = numInput('Max delay (sec)', 60);
    const pSearch = numInput('Search every (sec)', 180);
    const pCap = numInput('Session cap (replies)', 30);

    const startBtn = el('button', { class: 'xbot-btn' }, 'Start');
    const stopBtn = el('button', { class: 'xbot-btn secondary' }, 'Stop');
    const saveBtn = el('button', { class: 'xbot-btn secondary' }, 'Save');
    const resetBtn = el('button', { class: 'xbot-btn secondary' }, 'Reset history');

    const statusLine = el('div', { class: 'xbot-status-line' }, 'idle');
    const logsBox = el('pre', { class: 'xbot-logs' }, '');
    const error = el('div', { class: 'xbot-error' });

    function readForm() {
      const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
      return {
        keywords: lines(kwArea.value),
        templates: lines(tplArea.value),
        filters: {
          minLikes: numVal(fMinLikes, 0),
          maxAgeMinutes: numVal(fMaxAge, 240),
          minAuthorFollowers: numVal(fMinFollowers, 0),
          langs: fLangs.querySelector('input').value
            .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
          skipReplies: checkVal(fSkipReplies),
          skipRetweets: checkVal(fSkipRetweets),
          skipWithUrls: checkVal(fSkipUrls),
        },
        pacing: {
          minDelaySec: numVal(pMin, 25),
          maxDelaySec: numVal(pMax, 60),
          searchEverySec: numVal(pSearch, 180),
        },
        sessionCap: numVal(pCap, 30),
      };
    }

    function writeForm(cfg) {
      kwArea.value = (cfg.keywords || []).join('\n');
      tplArea.value = (cfg.templates || []).join('\n');
      setNum(fMinLikes, cfg.filters?.minLikes ?? 0);
      setNum(fMaxAge, cfg.filters?.maxAgeMinutes ?? 240);
      setNum(fMinFollowers, cfg.filters?.minAuthorFollowers ?? 0);
      fLangs.querySelector('input').value = (cfg.filters?.langs || []).join(',');
      setCheck(fSkipReplies, cfg.filters?.skipReplies ?? true);
      setCheck(fSkipRetweets, cfg.filters?.skipRetweets ?? true);
      setCheck(fSkipUrls, cfg.filters?.skipWithUrls ?? false);
      setNum(pMin, cfg.pacing?.minDelaySec ?? 25);
      setNum(pMax, cfg.pacing?.maxDelaySec ?? 60);
      setNum(pSearch, cfg.pacing?.searchEverySec ?? 180);
      setNum(pCap, cfg.sessionCap ?? 30);
    }

    saveBtn.addEventListener('click', async () => {
      error.textContent = '';
      const r = await send('auto.setConfig', readForm());
      if (!r.ok) { error.textContent = r.error; return; }
      saveBtn.textContent = 'Saved';
      setTimeout(() => (saveBtn.textContent = 'Save'), 1200);
    });

    startBtn.addEventListener('click', async () => {
      error.textContent = '';
      const cfg = readForm();
      if (!cfg.keywords.length) { error.textContent = 'Add at least one keyword.'; return; }
      if (!cfg.templates.length) { error.textContent = 'Add at least one template.'; return; }
      const s = await send('auto.setConfig', cfg);
      if (!s.ok) { error.textContent = s.error; return; }
      const r = await send('auto.start', {});
      if (!r.ok) { error.textContent = r.error; return; }
      refreshAuto();
    });
    stopBtn.addEventListener('click', async () => { await send('auto.stop', {}); refreshAuto(); });
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Clear sent-history? Replies already sent will be eligible again.')) return;
      await send('auto.resetSent', {});
    });

    pane.appendChild(kwLabel);
    pane.appendChild(kwArea);
    pane.appendChild(tplLabel);
    pane.appendChild(tplArea);

    pane.appendChild(el('div', { class: 'xbot-section' }, 'Filters'));
    pane.appendChild(el('div', { class: 'xbot-grid' },
      fMinLikes, fMaxAge, fMinFollowers, fLangs,
      fSkipReplies, fSkipRetweets, fSkipUrls,
    ));

    pane.appendChild(el('div', { class: 'xbot-section' }, 'Pacing & limits'));
    pane.appendChild(el('div', { class: 'xbot-grid' }, pMin, pMax, pSearch, pCap));

    pane.appendChild(el('div', { class: 'xbot-row', style: 'margin-top:10px' },
      startBtn, stopBtn, saveBtn, resetBtn,
    ));
    pane.appendChild(error);
    pane.appendChild(el('div', { class: 'xbot-section' }, 'Status'));
    pane.appendChild(statusLine);
    pane.appendChild(el('div', { class: 'xbot-section' }, 'Logs'));
    pane.appendChild(logsBox);

    // expose updaters so refreshAuto() can use them
    pane._writeForm = writeForm;
    pane._statusLine = statusLine;
    pane._logsBox = logsBox;
    pane._startBtn = startBtn;
    pane._stopBtn = stopBtn;

    return pane;
  }

  function numInput(label, defVal) {
    const w = el('label', { class: 'xbot-field' });
    w.appendChild(el('span', {}, label));
    const inp = el('input', { type: 'number', class: 'xbot-input' });
    inp.value = String(defVal);
    w.appendChild(inp);
    return w;
  }
  function textInput(label, defVal) {
    const w = el('label', { class: 'xbot-field' });
    w.appendChild(el('span', {}, label));
    const inp = el('input', { type: 'text', class: 'xbot-input' });
    inp.value = defVal;
    w.appendChild(inp);
    return w;
  }
  function check(label, defVal) {
    const w = el('label', { class: 'xbot-check' });
    const inp = el('input', { type: 'checkbox' });
    inp.checked = !!defVal;
    w.appendChild(inp);
    w.appendChild(el('span', {}, label));
    return w;
  }
  const numVal = (w, def) => {
    const v = parseInt(w.querySelector('input').value, 10);
    return Number.isFinite(v) ? v : def;
  };
  const setNum = (w, v) => { w.querySelector('input').value = String(v); };
  const checkVal = (w) => w.querySelector('input').checked;
  const setCheck = (w, v) => { w.querySelector('input').checked = !!v; };

  // ---------- COMMENTS tab (kept) ----------
  function buildCommentsPane() {
    const input = el('input', {
      class: 'xbot-input',
      placeholder: 'https://x.com/<user>/status/<id>  or just tweet id',
    });
    const fetchBtn = el('button', { class: 'xbot-btn' }, 'Load replies');
    const list = el('div', { class: 'xbot-list' });
    const replyText = el('textarea', {
      class: 'xbot-textarea',
      placeholder: 'Reply text. Sent to whichever reply you click on.',
    });
    const error = el('div', { class: 'xbot-error' });

    fetchBtn.addEventListener('click', async () => {
      error.textContent = '';
      list.innerHTML = '';
      const m = input.value.match(TWEET_ID_RE);
      const id = m ? m[1] : input.value.trim();
      if (!/^\d+$/.test(id)) { error.textContent = 'Could not extract tweet id.'; return; }
      fetchBtn.disabled = true; fetchBtn.textContent = 'Loading...';
      const resp = await send('x.tweetDetail', { tweetId: id });
      fetchBtn.disabled = false; fetchBtn.textContent = 'Load replies';
      if (!resp.ok) { error.textContent = resp.error; return; }
      const replies = resp.data.replies || [];
      if (!replies.length) { list.appendChild(el('div', { class: 'xbot-empty' }, 'No replies found.')); return; }
      for (const r of replies) {
        const card = el('div', { class: 'xbot-card' });
        card.appendChild(el('div', { class: 'xbot-meta' },
          el('strong', {}, '@' + (r.authorHandle || '?'))));
        card.appendChild(el('div', { class: 'xbot-text' }, r.text || ''));
        const replyBtn = el('button', { class: 'xbot-btn' }, 'Reply');
        replyBtn.addEventListener('click', async () => {
          const text = replyText.value.trim();
          if (!text) { error.textContent = 'Reply text empty.'; return; }
          replyBtn.disabled = true; replyBtn.textContent = 'Sending...';
          const sr = await send('x.createTweet', { text, replyToTweetId: r.id });
          replyBtn.disabled = false;
          if (!sr.ok) { error.textContent = sr.error; replyBtn.textContent = 'Reply'; return; }
          replyBtn.textContent = 'Sent';
        });
        card.appendChild(el('div', { class: 'xbot-actions' }, replyBtn));
        list.appendChild(card);
      }
    });

    return el('div', { class: 'xbot-pane', 'data-pane': 'comments' },
      el('div', { class: 'xbot-row' }, input, fetchBtn),
      replyText, error,
      el('div', { style: 'height:8px' }), list,
    );
  }

  // ---------- STATUS tab ----------
  function buildStatusPane() {
    const pane = el('div', { class: 'xbot-pane', 'data-pane': 'status' });
    pane.innerHTML = '<div class="xbot-empty">Loading capture state...</div>';
    return pane;
  }

  function renderStatus() {
    const pane = root.querySelector('[data-pane="status"]');
    if (!pane) return;
    const ops = captureState.ops || {};
    const names = Object.keys(ops).sort();
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'xbot-card' },
      el('div', { class: 'xbot-meta' }, el('strong', {}, 'Captured GraphQL operations')),
      el('div', { class: 'xbot-text' },
        names.length ? names.map((n) => `${n}  (queryId: ${ops[n].queryId.slice(0, 8)}…)`).join('\n')
                     : 'No operations captured yet.'),
    ));
    const required = ['CreateTweet', 'SearchTimeline'];
    const missing = required.filter((n) => !ops[n]);
    pane.appendChild(el('div', { class: 'xbot-card', style: 'margin-top:8px' },
      el('div', { class: 'xbot-meta' }, el('strong', {}, 'Required for auto-reply')),
      el('div', { class: 'xbot-text' },
        missing.length
          ? 'Missing: ' + missing.join(', ') +
            '\n→ SearchTimeline: type anything in the X search bar and press Enter.' +
            '\n→ CreateTweet: post or reply to anything once.'
          : 'All required ops captured. You can press Start in the Auto-reply tab.'),
    ));
  }

  function updateFab() {
    const required = ['CreateTweet', 'SearchTimeline'];
    const ok = required.every((n) => captureState.ops && captureState.ops[n]);
    const badge = fab.querySelector('.xbot-badge');
    if (autoState.status === 'running') {
      badge.textContent = String(autoState.sentInSession || 0);
      badge.classList.remove('warn'); badge.classList.add('run');
    } else if (ok) {
      badge.textContent = 'OK';
      badge.classList.remove('warn'); badge.classList.remove('run');
    } else {
      badge.textContent = String(required.filter((n) => !captureState.ops[n]).length);
      badge.classList.add('warn'); badge.classList.remove('run');
    }
    statusDot.className = 'xbot-dot';
    if (autoState.status === 'running') { statusDot.classList.add('run'); statusText.textContent = 'Auto-reply running'; }
    else if (ok) { statusDot.classList.add('ok'); statusText.textContent = 'Ready'; }
    else { statusDot.classList.add('warn'); statusText.textContent = 'Warming up — search something on X & post once'; }
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }

  async function refreshAuto() {
    const [stateR, logsR] = await Promise.all([
      send('auto.getState', {}),
      send('auto.getLogs', {}),
    ]);
    if (stateR.ok) autoState = stateR.data;
    const pane = root.querySelector('[data-pane="auto"]');
    if (!pane) return;
    pane._statusLine.textContent =
      `${autoState.status.toUpperCase()} · sent this session: ${autoState.sentInSession || 0}` +
      (autoState.lastError ? ` · last error: ${autoState.lastError}` : '');
    pane._statusLine.className = 'xbot-status-line ' + (autoState.status === 'running' ? 'run' : 'idle');
    pane._startBtn.disabled = autoState.status === 'running';
    pane._stopBtn.disabled = autoState.status !== 'running';
    if (logsR.ok) {
      const lines = (logsR.data || []).slice(-50).reverse()
        .map((l) => `[${fmtTime(l.ts)}] ${l.level.toUpperCase()}  ${l.msg}`).join('\n');
      pane._logsBox.textContent = lines || '(no log entries yet)';
    }
    updateFab();
  }

  async function refreshCapture() {
    const resp = await send('capture.state', {});
    if (resp.ok) {
      captureState = resp.data;
      updateFab();
      if (activeTab === 'status') renderStatus();
    }
  }

  async function refreshAll() {
    await Promise.all([refreshCapture(), refreshAuto()]);
    if (!autoConfig) {
      const cfgR = await send('auto.getConfig', {});
      if (cfgR.ok) {
        autoConfig = cfgR.data;
        const pane = root.querySelector('[data-pane="auto"]');
        if (pane && pane._writeForm) pane._writeForm(autoConfig);
      }
    }
  }

  function build() {
    root = el('div', { id: 'xbot-root' });

    fab = el('button', { id: 'xbot-fab', title: 'X Reply Bot', html: XBotIcons.bot });
    fab.appendChild(el('span', { class: 'xbot-badge warn' }, '…'));
    fab.addEventListener('click', open);

    overlay = el('div', { id: 'xbot-overlay', onclick: close });

    const header = el('div', { class: 'xbot-header' },
      el('h2', {}, 'X Reply Bot'),
      el('button', { title: 'Refresh', html: XBotIcons.refresh, onclick: refreshAll }),
      el('button', { title: 'Close', html: XBotIcons.close, onclick: close }),
    );

    const tabs = el('div', { class: 'xbot-tabs' });
    const tabDefs = [
      ['auto', 'Auto-reply'],
      ['comments', 'Comments'],
      ['status', 'Status'],
    ];
    for (const [key, label] of tabDefs) {
      const b = el('button', { class: 'xbot-tab', 'data-tab': key }, label);
      b.addEventListener('click', () => setActiveTab(key));
      if (key === activeTab) b.classList.add('active');
      tabs.appendChild(b);
    }

    const body = el('div', { class: 'xbot-body' },
      buildAutoPane(),
      buildCommentsPane(),
      buildStatusPane(),
    );

    statusDot = el('span', { class: 'xbot-dot warn' });
    statusText = el('span', {}, 'Initializing…');
    const statusBar = el('div', { class: 'xbot-status' }, statusDot, statusText);

    modal = el('div', { id: 'xbot-modal' }, header, tabs, body, statusBar);

    root.appendChild(fab);
    root.appendChild(overlay);
    root.appendChild(modal);
    document.documentElement.appendChild(root);
  }

  function init() {
    if (document.getElementById('xbot-root')) return;
    build();
    refreshAll();
    if (pollHandle) clearInterval(pollHandle);
    // Poll less often when modal is closed; more often when open.
    pollHandle = setInterval(() => {
      if (modal.classList.contains('open')) refreshAll();
      else refreshCapture();
    }, 3000);
  }

  return { init };
})();
