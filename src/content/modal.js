// Modal UI. Lives in the isolated content-script world.
// Communicates with the background service worker via chrome.runtime.sendMessage.
//
// Tabs:
//   - comments  : paste tweet URL/id, fetch replies, reply to selected
//   - search    : keyword search (stub for now)
//   - users     : reply by @username (stub for now)
//   - status    : capture readiness
const XBotModal = (() => {
  const TWEET_ID_RE = /(?:status|statuses)\/(\d+)/;

  let root, modal, overlay, fab, statusDot, statusText;
  let activeTab = 'comments';
  let captureState = { ready: false, ops: {} };

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
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: 'no response' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function open() {
    overlay.classList.add('open');
    modal.classList.add('open');
    refreshStatus();
  }
  function close() {
    overlay.classList.remove('open');
    modal.classList.remove('open');
  }

  function setActiveTab(name) {
    activeTab = name;
    root.querySelectorAll('.xbot-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    root.querySelectorAll('.xbot-pane').forEach((p) => {
      p.classList.toggle('active', p.dataset.pane === name);
    });
  }

  // ---------- Comments tab ----------
  function buildCommentsPane() {
    const input = el('input', {
      class: 'xbot-input',
      placeholder: 'https://x.com/<user>/status/<id>  or just tweet id',
    });
    const fetchBtn = el('button', { class: 'xbot-btn' }, 'Load replies');
    const list = el('div', { class: 'xbot-list' });
    const replyText = el('textarea', {
      class: 'xbot-textarea',
      placeholder: 'Reply text. Will be sent to whichever reply you click "Reply" on.',
    });
    const error = el('div', { class: 'xbot-error' });

    let loadedReplies = [];
    let parentTweetId = null;

    fetchBtn.addEventListener('click', async () => {
      error.textContent = '';
      list.innerHTML = '';
      const m = input.value.match(TWEET_ID_RE);
      const id = m ? m[1] : input.value.trim();
      if (!/^\d+$/.test(id)) {
        error.textContent = 'Could not extract tweet id.';
        return;
      }
      parentTweetId = id;
      fetchBtn.disabled = true;
      fetchBtn.textContent = 'Loading...';
      const resp = await send('x.tweetDetail', { tweetId: id });
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Load replies';
      if (!resp.ok) {
        error.textContent = resp.error || 'Failed to load.';
        return;
      }
      loadedReplies = resp.data.replies || [];
      if (!loadedReplies.length) {
        list.appendChild(el('div', { class: 'xbot-empty' }, 'No replies found.'));
        return;
      }
      for (const r of loadedReplies) {
        const card = el('div', { class: 'xbot-card' });
        card.appendChild(el(
          'div', { class: 'xbot-meta' },
          el('strong', {}, '@' + (r.authorHandle || '?')),
          el('span', {}, r.text ? '' : '(no text)'),
        ));
        card.appendChild(el('div', { class: 'xbot-text' }, r.text || ''));
        const replyBtn = el('button', { class: 'xbot-btn' }, 'Reply');
        replyBtn.addEventListener('click', async () => {
          const text = replyText.value.trim();
          if (!text) {
            error.textContent = 'Reply text is empty.';
            return;
          }
          replyBtn.disabled = true;
          replyBtn.textContent = 'Sending...';
          const send_resp = await send('x.createTweet', {
            text,
            replyToTweetId: r.id,
          });
          replyBtn.disabled = false;
          replyBtn.textContent = 'Reply';
          if (!send_resp.ok) {
            error.textContent = send_resp.error || 'Send failed.';
            return;
          }
          replyBtn.textContent = 'Sent';
          replyBtn.disabled = true;
        });
        card.appendChild(el('div', { class: 'xbot-actions' }, replyBtn));
        list.appendChild(card);
      }
    });

    return el('div', { class: 'xbot-pane active', 'data-pane': 'comments' },
      el('div', { class: 'xbot-row' }, input, fetchBtn),
      el('div', {}, replyText),
      error,
      el('div', { style: 'height:8px' }),
      list,
    );
  }

  // ---------- stub panes ----------
  function buildStubPane(name, label) {
    return el('div', { class: 'xbot-pane', 'data-pane': name },
      el('div', { class: 'xbot-empty' },
        label + ' coming next. The capture system is already collecting the requests it will need.'),
    );
  }

  // ---------- status pane ----------
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
        names.length
          ? names.map((n) => `${n}  (queryId: ${ops[n].queryId.slice(0, 8)}…)`).join('\n')
          : 'No operations captured yet. Scroll the X feed and open a tweet to warm up.'),
    ));
    const need = ['CreateTweet', 'TweetDetail'];
    const missing = need.filter((n) => !ops[n]);
    pane.appendChild(el('div', { class: 'xbot-card', style: 'margin-top:8px' },
      el('div', { class: 'xbot-meta' }, el('strong', {}, 'Required for current features')),
      el('div', { class: 'xbot-text' },
        missing.length
          ? 'Missing: ' + missing.join(', ') +
            '\n→ TweetDetail: open any tweet permalink.' +
            '\n→ CreateTweet: post or reply to anything once.'
          : 'All required operations captured. You can use the Comments tab.'),
    ));
  }

  function updateFab() {
    const required = ['CreateTweet', 'TweetDetail'];
    const ok = required.every((n) => captureState.ops && captureState.ops[n]);
    const badge = fab.querySelector('.xbot-badge');
    if (ok) {
      badge.textContent = 'OK';
      badge.classList.remove('warn');
    } else {
      const missing = required.filter((n) => !captureState.ops || !captureState.ops[n]).length;
      badge.textContent = String(missing);
      badge.classList.add('warn');
    }
    statusDot.classList.toggle('ok', ok);
    statusDot.classList.toggle('warn', !ok);
    statusText.textContent = ok ? 'Ready' : 'Warming up — browse X to capture endpoints';
  }

  async function refreshStatus() {
    const resp = await send('capture.state', {});
    if (resp.ok) {
      captureState = resp.data;
      updateFab();
      if (activeTab === 'status') renderStatus();
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
      el('button', { title: 'Refresh', html: XBotIcons.refresh, onclick: refreshStatus }),
      el('button', { title: 'Close', html: XBotIcons.close, onclick: close }),
    );

    const tabs = el('div', { class: 'xbot-tabs' });
    const tabDefs = [
      ['comments', 'Comments'],
      ['search', 'Search/Feed'],
      ['users', 'By @user'],
      ['status', 'Status'],
    ];
    for (const [key, label] of tabDefs) {
      const b = el('button', { class: 'xbot-tab', 'data-tab': key }, label);
      b.addEventListener('click', () => setActiveTab(key));
      if (key === activeTab) b.classList.add('active');
      tabs.appendChild(b);
    }

    const body = el('div', { class: 'xbot-body' },
      buildCommentsPane(),
      buildStubPane('search', 'Search/Feed automation'),
      buildStubPane('users', 'Reply by @username'),
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
    refreshStatus();
    setInterval(refreshStatus, 5000);
  }

  return { init };
})();
