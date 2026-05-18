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
  let autoConfigLoaded = false;
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
    if (name === 'status') renderStatus();
  }

  // ---------- AUTO tab ----------
  function buildAutoPane() {
    const pane = el('div', { class: 'xbot-pane active', 'data-pane': 'auto' });

    const kwLabel = el('label', { class: 'xbot-label' },
      'Keywords (one per line — these go straight into X search; supports operators like "min_faves:50 lang:en -filter:replies")');
    const kwArea = el('textarea', {
      class: 'xbot-textarea', rows: '4',
      placeholder: 'gm\ngm degens\ngm all\nsolana min_faves:5 lang:en -filter:replies',
    });

    const tplLabel = el('label', { class: 'xbot-label' },
      'Reply templates (one per line — random pick with diversity cooldown; supports {author}, {name})');
    const tplArea = el('textarea', { class: 'xbot-textarea', rows: '5',
      placeholder: 'gm fren\nGM! Have a great one\ngm @{author}',
    });

    // Filters
    const fMinLikes = numInput('Min likes', 1);
    const fMinAgeSec = numInput('Min tweet age (sec)', 60);
    const fMaxAge = numInput('Max age (min)', 30);
    const fMinFollowers = numInput('Min followers', 50);
    const fLangs = textInput('Langs (comma) e.g. en,ru', '');
    const fSkipReplies = check('Skip replies', true);
    const fSkipRetweets = check('Skip retweets', true);
    const fSkipQuotes = check('Skip quotes', false);
    const fSkipUrls = check('Skip posts with links', false);
    const fBlackWords = textInput('Blacklist words (comma)', '');
    const fBlackHandles = textInput('Blacklist @handles (comma)', '');

    // Pacing
    const pMin = numInput('Min delay (sec)', 25);
    const pMax = numInput('Max delay (sec)', 90);
    const pSearch = numInput('Search every (sec)', 180);
    const pHour = numInput('Max replies/hour', 15);
    const pDiv = numInput('Template diversity (sec)', 1800);
    const pCap = numInput('Session cap (replies)', 30);

    // Sleep window
    const sleepEn = check('Sleep window enabled', false);
    const sleepStart = textInput('Sleep start (HH:MM, local)', '01:00');
    const sleepEnd = textInput('Sleep end (HH:MM, local)', '08:00');

    const startBtn = el('button', { class: 'xbot-btn' }, 'Start');
    const stopBtn = el('button', { class: 'xbot-btn secondary' }, 'Stop');
    const saveBtn = el('button', { class: 'xbot-btn secondary' }, 'Save');
    const resetBtn = el('button', { class: 'xbot-btn secondary' }, 'Reset history');

    const statusLine = el('div', { class: 'xbot-status-line' }, 'idle');
    const logsBox = el('pre', { class: 'xbot-logs' }, '');
    const error = el('div', { class: 'xbot-error' });

    function readForm() {
      const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
      const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
      return {
        keywords: lines(kwArea.value),
        templates: lines(tplArea.value),
        filters: {
          minLikes: numVal(fMinLikes, 0),
          minTweetAgeSec: numVal(fMinAgeSec, 60),
          maxAgeMinutes: numVal(fMaxAge, 30),
          minAuthorFollowers: numVal(fMinFollowers, 0),
          langs: csv(getInput(fLangs).value).map((x) => x.toLowerCase()),
          skipReplies: checkVal(fSkipReplies),
          skipRetweets: checkVal(fSkipRetweets),
          skipQuotes: checkVal(fSkipQuotes),
          skipWithUrls: checkVal(fSkipUrls),
          blacklistWords: csv(getInput(fBlackWords).value),
          blacklistHandles: csv(getInput(fBlackHandles).value).map((s) => s.replace(/^@/, '')),
        },
        pacing: {
          minDelaySec: numVal(pMin, 25),
          maxDelaySec: numVal(pMax, 90),
          searchEverySec: numVal(pSearch, 180),
          maxRepliesPerHour: numVal(pHour, 15),
          diversityCooldownSec: numVal(pDiv, 1800),
        },
        sleep: {
          enabled: checkVal(sleepEn),
          startHHMM: getInput(sleepStart).value.trim() || '01:00',
          endHHMM: getInput(sleepEnd).value.trim() || '08:00',
        },
        sessionCap: numVal(pCap, 30),
      };
    }

    function writeForm(cfg) {
      kwArea.value = (cfg.keywords || []).join('\n');
      tplArea.value = (cfg.templates || []).join('\n');
      const f = cfg.filters || {};
      setNum(fMinLikes, f.minLikes ?? 0);
      setNum(fMinAgeSec, f.minTweetAgeSec ?? 60);
      setNum(fMaxAge, f.maxAgeMinutes ?? 30);
      setNum(fMinFollowers, f.minAuthorFollowers ?? 0);
      getInput(fLangs).value = (f.langs || []).join(',');
      setCheck(fSkipReplies, f.skipReplies ?? true);
      setCheck(fSkipRetweets, f.skipRetweets ?? true);
      setCheck(fSkipQuotes, f.skipQuotes ?? false);
      setCheck(fSkipUrls, f.skipWithUrls ?? false);
      getInput(fBlackWords).value = (f.blacklistWords || []).join(',');
      getInput(fBlackHandles).value = (f.blacklistHandles || []).join(',');
      const p = cfg.pacing || {};
      setNum(pMin, p.minDelaySec ?? 25);
      setNum(pMax, p.maxDelaySec ?? 90);
      setNum(pSearch, p.searchEverySec ?? 180);
      setNum(pHour, p.maxRepliesPerHour ?? 15);
      setNum(pDiv, p.diversityCooldownSec ?? 1800);
      setNum(pCap, cfg.sessionCap ?? 30);
      const sl = cfg.sleep || {};
      setCheck(sleepEn, sl.enabled ?? false);
      getInput(sleepStart).value = sl.startHHMM || '01:00';
      getInput(sleepEnd).value = sl.endHHMM || '08:00';
    }

    saveBtn.addEventListener('click', async () => {
      error.textContent = '';
      const r = await send('auto.setConfig', readForm());
      if (!r.ok) { error.textContent = r.error; return; }
      saveBtn.textContent = 'Saved'; setTimeout(() => (saveBtn.textContent = 'Save'), 1200);
    });
    startBtn.addEventListener('click', async () => {
      error.textContent = '';
      const cfg = readForm();
      if (!cfg.keywords.length) { error.textContent = 'Add at least one keyword.'; return; }
      if (!cfg.templates.length) { error.textContent = 'Add at least one template.'; return; }
      const s = await send('auto.setConfig', cfg); if (!s.ok) { error.textContent = s.error; return; }
      const r = await send('auto.start', {}); if (!r.ok) { error.textContent = r.error; return; }
      refreshAuto();
    });
    stopBtn.addEventListener('click', async () => { await send('auto.stop', {}); refreshAuto(); });
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Clear sent-history? Replies already sent will be eligible again.')) return;
      await send('auto.resetSent', {});
    });

    pane.appendChild(kwLabel); pane.appendChild(kwArea);
    pane.appendChild(tplLabel); pane.appendChild(tplArea);

    pane.appendChild(el('div', { class: 'xbot-section' }, 'Filters'));
    pane.appendChild(el('div', { class: 'xbot-grid' },
      fMinLikes, fMinAgeSec, fMaxAge, fMinFollowers,
      fSkipReplies, fSkipRetweets, fSkipQuotes, fSkipUrls,
    ));
    pane.appendChild(el('div', { class: 'xbot-grid xbot-grid-1' }, fLangs));
    pane.appendChild(el('div', { class: 'xbot-grid xbot-grid-1' }, fBlackWords));
    pane.appendChild(el('div', { class: 'xbot-grid xbot-grid-1' }, fBlackHandles));

    pane.appendChild(el('div', { class: 'xbot-section' }, 'Pacing & limits'));
    pane.appendChild(el('div', { class: 'xbot-grid' },
      pMin, pMax, pSearch, pHour, pDiv, pCap,
    ));

    pane.appendChild(el('div', { class: 'xbot-section' }, 'Sleep window (local time)'));
    pane.appendChild(el('div', { class: 'xbot-grid' }, sleepEn, sleepStart, sleepEnd));

    pane.appendChild(el('div', { class: 'xbot-row', style: 'margin-top:14px' },
      startBtn, stopBtn, saveBtn, resetBtn,
    ));
    pane.appendChild(error);

    pane.appendChild(el('div', { class: 'xbot-section' }, 'Status'));
    pane.appendChild(statusLine);
    pane.appendChild(el('div', { class: 'xbot-section' }, 'Logs'));
    pane.appendChild(logsBox);

    pane._writeForm = writeForm;
    pane._statusLine = statusLine;
    pane._logsBox = logsBox;
    pane._startBtn = startBtn;
    pane._stopBtn = stopBtn;
    return pane;
  }

  function getInput(field) { return field.querySelector('input'); }
  function numInput(label, defVal) {
    const w = el('label', { class: 'xbot-field' });
    w.appendChild(el('span', {}, label));
    const inp = el('input', { type: 'number', class: 'xbot-input' });
    inp.value = String(defVal); w.appendChild(inp); return w;
  }
  function textInput(label, defVal) {
    const w = el('label', { class: 'xbot-field' });
    w.appendChild(el('span', {}, label));
    const inp = el('input', { type: 'text', class: 'xbot-input' });
    inp.value = defVal; w.appendChild(inp); return w;
  }
  function check(label, defVal) {
    const w = el('label', { class: 'xbot-check' });
    const inp = el('input', { type: 'checkbox' });
    inp.checked = !!defVal; w.appendChild(inp);
    w.appendChild(el('span', {}, label)); return w;
  }
  const numVal = (w, def) => {
    const v = parseInt(getInput(w).value, 10);
    return Number.isFinite(v) ? v : def;
  };
  const setNum = (w, v) => { getInput(w).value = String(v); };
  const checkVal = (w) => getInput(w).checked;
  const setCheck = (w, v) => { getInput(w).checked = !!v; };

  // ---------- COMMENTS tab (kept) ----------
  function buildCommentsPane() {
    const input = el('input', { class: 'xbot-input',
      placeholder: 'https://x.com/<user>/status/<id>  or just tweet id' });
    const fetchBtn = el('button', { class: 'xbot-btn' }, 'Load replies');
    const list = el('div', { class: 'xbot-list' });
    const replyText = el('textarea', { class: 'xbot-textarea',
      placeholder: 'Reply text. Sent to whichever reply you click on.' });
    const error = el('div', { class: 'xbot-error' });

    fetchBtn.addEventListener('click', async () => {
      error.textContent = ''; list.innerHTML = '';
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
      replyText, error, el('div', { style: 'height:8px' }), list,
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
    badge.classList.remove('warn'); badge.classList.remove('run');
    if (autoState.status === 'running') {
      badge.textContent = String(autoState.sentInSession || 0);
      badge.classList.add('run');
    } else if (ok) {
      badge.textContent = 'OK';
    } else {
      badge.textContent = String(required.filter((n) => !captureState.ops[n]).length);
      badge.classList.add('warn');
    }
    statusDot.className = 'xbot-dot';
    if (autoState.status === 'running') { statusDot.classList.add('run'); statusText.textContent = 'Auto-reply running'; }
    else if (ok) { statusDot.classList.add('ok'); statusText.textContent = 'Ready'; }
    else { statusDot.classList.add('warn'); statusText.textContent = 'Warming up — search something on X & post once'; }
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }

  async function refreshAuto() {
    const [stateR, logsR] = await Promise.all([
      send('auto.getState', {}), send('auto.getLogs', {}),
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
    if (!autoConfigLoaded) {
      const cfgR = await send('auto.getConfig', {});
      if (cfgR.ok) {
        autoConfigLoaded = true;
        const pane = root.querySelector('[data-pane="auto"]');
        if (pane && pane._writeForm) pane._writeForm(cfgR.data);
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
      buildAutoPane(), buildCommentsPane(), buildStatusPane(),
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
    pollHandle = setInterval(() => {
      if (modal.classList.contains('open')) refreshAll();
      else refreshCapture();
    }, 3000);
  }

  return { init };
})();
