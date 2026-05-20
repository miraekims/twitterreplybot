// X Reply Bot — Telegram Mini App frontend
// Step-by-step wizard UX, campaigns addressed by @handle (not numeric id)

const API = window.location.origin + '/api';
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

let state = {
  status: null,
  campaigns: [],
  currentCampaign: null,
  presets: null,
  personas: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}
const get = (p) => api(p);
const post = (p, body) => api(p, { method: 'POST', body });
const put = (p, body) => api(p, { method: 'PUT', body });


// ---------- Init ----------
async function init() {
  try {
    const [statusRes, campaignsRes, presetsRes, personasRes] = await Promise.all([
      get('/status'),
      get('/campaigns'),
      get('/presets'),
      get('/personas'),
    ]);
    state.status = statusRes;
    state.campaigns = campaignsRes.campaigns || [];
    state.presets = presetsRes.presets || {};
    state.personas = personasRes.personas || [];
  } catch (e) {
    showScreen('loading');
    $('#loading p').textContent = 'Connection error. Check bot is running.';
    return;
  }

  if (!state.status.bridge) {
    showScreen('disconnected');
    return;
  }

  if (state.campaigns.length === 0) {
    startWizard();
  } else {
    showDashboard();
  }
}

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}


// ---------- Render screens dynamically ----------
function render(html) {
  const app = $('#app');
  // Keep loading screen structure, add new content
  app.innerHTML = html;
}

function toast(msg) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- Disconnected screen ----------
function showDisconnected() {
  render(`
    <div id="disconnected" class="screen active">
      <div class="discon-icon">🔌</div>
      <h2 class="wizard-title" style="text-align:center;">Extension offline</h2>
      <p class="wizard-subtitle" style="text-align:center;">
        Open Chrome with the X Reply Bot extension enabled<br>
        and make sure you're logged into x.com
      </p>
      <div style="display:flex; justify-content:center; margin-top:8px;">
        <button class="btn btn-primary btn-cta" style="max-width:240px;" onclick="init()">
          Retry connection
        </button>
      </div>
    </div>
  `);
}


// ---------- Dashboard ----------
function showDashboard() {
  const handle = state.status.handle || '?';
  const avatarLetter = (handle && handle !== '?' ? handle[0] : '@').toUpperCase();
  const c = state.campaigns[0]; // primary campaign
  state.currentCampaign = c;
  const statusDot = c.status === 'running' ? 'green' : c.status === 'error' ? 'red' : 'yellow';
  const statusText = c.status === 'running' ? 'Active' : c.status === 'paused' ? 'Paused' : c.status === 'error' ? 'Error' : 'Idle';

  render(`
    <div id="dashboard" class="screen active">
      <div class="header">
        <div class="avatar">${avatarLetter}</div>
        <div class="info">
          <h2>@${handle}</h2>
          <div class="status">
            <span class="dot ${statusDot}"></span>
            <span>${statusText}</span>
          </div>
        </div>
      </div>

      <div class="hero-card">
        <div class="label">Replies sent</div>
        <div class="big">${c.sentTotal || 0}</div>
        <div class="small">~${c.dailyEstimate || 0} per day capacity</div>
      </div>

      <div class="stats-row" style="margin-top:12px;">
        <div class="card">
          <h3>Last hour</h3>
          <div class="value">${c.sentLastHour || 0}</div>
          <div class="sub">replies</div>
        </div>
        <div class="card">
          <h3>Status</h3>
          <div class="value" style="font-size:22px;">${statusText}</div>
          <div class="sub">${c.status === 'running' ? 'campaign live' : 'tap Run to start'}</div>
        </div>
      </div>

      <div class="btn-row">
        ${c.status === 'running'
          ? '<button class="btn btn-danger" onclick="pauseCampaign()">Pause</button>'
          : '<button class="btn btn-success btn-cta" onclick="runCampaign()">Run</button>'
        }
        <button class="btn btn-outline" onclick="showSettings()">Settings</button>
      </div>

      ${c.lastError ? `<div class="card error-card" style="margin-top:12px;">
        <h3>Last Error</h3>
        <p style="font-size:12px;">${escHtml(c.lastError)}</p>
      </div>` : ''}

      <div class="section-title">Campaigns</div>
      ${state.campaigns.map(renderCampaignItem).join('')}
      <button class="btn btn-outline" style="margin-top:8px;" onclick="startWizard()">+ New Campaign</button>

      ${renderNav('home')}
    </div>
  `);
}

function renderCampaignItem(c) {
  const badge = c.status === 'running' ? 'badge-running'
    : c.status === 'paused' ? 'badge-paused'
    : c.status === 'error' ? 'badge-error' : 'badge-idle';
  return `
    <div class="campaign-item" onclick="selectCampaign(${c.id})">
      <div class="top">
        <span class="name">${c.name}</span>
        <span class="badge ${badge}">${c.status}</span>
      </div>
      <div class="meta">@${c.handle} &middot; ${c.sentTotal} sent &middot; ~${c.dailyEstimate}/day</div>
    </div>
  `;
}

// SVG icons — Blum outline style (24x24, stroke-based)
const NAV_ICONS = {
  home: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10.5z"/><path d="M9 21V14h6v7"/></svg>`,
  growth: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l4-4 4 2 4-6 6-4"/><circle cx="21" cy="8" r="2"/><path d="M3 20h18"/></svg>`,
  queue: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="5" rx="1.5"/><path d="M7 19h10"/></svg>`,
  tune: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/></svg>`,
  logs: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 8h10M7 12h6M7 16h8"/></svg>`,
};

function renderNav(active) {
  const items = [
    { id: 'home',   label: 'Home' },
    { id: 'growth', label: 'Growth' },
    { id: 'queue',  label: 'Queue' },
    { id: 'tune',   label: 'Tune' },
    { id: 'logs',   label: 'Logs' },
  ];
  return `<nav class="nav">${items.map(i =>
    `<div class="nav-item ${i.id === active ? 'active' : ''}" onclick="navTo('${i.id}')">
      <span class="icon">${NAV_ICONS[i.id]}</span>${i.label}
    </div>`
  ).join('')}</nav>`;
}


// ---------- Navigation ----------
async function navTo(tab) {
  if (tab === 'home') return showDashboard();
  if (tab === 'growth') return showGrowth();
  if (tab === 'queue') return showQueue();
  if (tab === 'tune') return showSettings();
  if (tab === 'logs') return showLogs();
}

async function selectCampaign(id) {
  const res = await get(`/campaign/${id}`);
  state.currentCampaign = res;
  showCampaignDetail();
}

async function runCampaign() {
  if (!state.currentCampaign) return;
  await post(`/campaign/${state.currentCampaign.id}/run`);
  toast('Campaign started!');
  state.currentCampaign.status = 'running';
  showDashboard();
}

async function pauseCampaign() {
  if (!state.currentCampaign) return;
  await post(`/campaign/${state.currentCampaign.id}/pause`);
  toast('Campaign paused');
  state.currentCampaign.status = 'paused';
  showDashboard();
}


// ---------- Wizard (new campaign creation) ----------
let wizardState = { step: 0, data: {} };
const WIZARD_STEPS = ['name', 'keywords', 'templates', 'persona', 'pacing', 'confirm'];

function startWizard() {
  wizardState = { step: 0, data: { preset: 'safe' } };
  renderWizardStep();
}

function renderWizardStep() {
  const step = wizardState.step;
  const totalSteps = WIZARD_STEPS.length;
  const progressHtml = `<div class="wizard-progress">${WIZARD_STEPS.map((_, i) =>
    `<div class="step ${i < step ? 'done' : i === step ? 'current' : ''}"></div>`
  ).join('')}</div>`;

  let content = '';
  switch (WIZARD_STEPS[step]) {
    case 'name': content = wizardName(); break;
    case 'keywords': content = wizardKeywords(); break;
    case 'templates': content = wizardTemplates(); break;
    case 'persona': content = wizardPersona(); break;
    case 'pacing': content = wizardPacing(); break;
    case 'confirm': content = wizardConfirm(); break;
  }

  render(`
    <div id="wizard" class="screen active">
      ${progressHtml}
      ${content}
    </div>
  `);
}

function wizardNext() {
  wizardState.step++;
  if (wizardState.step >= WIZARD_STEPS.length) {
    submitWizard();
  } else {
    renderWizardStep();
  }
}

function wizardBack() {
  if (wizardState.step > 0) {
    wizardState.step--;
    renderWizardStep();
  }
}


function wizardName() {
  const handle = state.status?.handle || 'your account';
  return `
    <div class="wizard-title">Name your campaign</div>
    <div class="wizard-subtitle">For @${handle}. Give it a short memorable name.</div>
    <div class="field">
      <label>Campaign name</label>
      <input type="text" id="w-name" placeholder="e.g. Crypto Growth" value="${wizardState.data.name || ''}">
      <div class="hint">You can have multiple campaigns with different keywords/personas.</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="showDashboard()">Cancel</button>
      <button class="btn btn-primary" onclick="saveWizardName()">Next</button>
    </div>
  `;
}
function saveWizardName() {
  const v = document.getElementById('w-name')?.value?.trim();
  if (!v) { toast('Please enter a name'); return; }
  wizardState.data.name = v;
  wizardNext();
}

function wizardKeywords() {
  return `
    <div class="wizard-title">Keywords</div>
    <div class="wizard-subtitle">The bot scans your X home feed and replies to tweets matching these keywords.</div>
    <div class="field">
      <label>Keywords (one per line)</label>
      <textarea id="w-keywords" placeholder="solana\ncrypto\ngm">${(wizardState.data.keywords || []).join('\n')}</textarea>
      <div class="hint">Case-insensitive. Multi-word = all words must appear. Empty = reply to everything in feed.</div>
      <div class="example">Examples:\nsolana\ngm crypto\nbullish eth\nairdrop</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="wizardBack()">Back</button>
      <button class="btn btn-primary" onclick="saveWizardKeywords()">Next</button>
    </div>
  `;
}
function saveWizardKeywords() {
  const v = document.getElementById('w-keywords')?.value || '';
  wizardState.data.keywords = v.split('\n').map(s => s.trim()).filter(Boolean);
  wizardNext();
}


function wizardTemplates() {
  return `
    <div class="wizard-title">Reply Templates</div>
    <div class="wizard-subtitle">Templates guide the AI on how to reply. Format: "tags | reply text"</div>
    <div class="field">
      <label>Templates (one per line)</label>
      <textarea id="w-templates" placeholder="gm, good morning | gm fren\nchart, ta | nice setup, what's your target?">${(wizardState.data.templates || []).join('\n')}</textarea>
      <div class="hint">Tags = comma-separated triggers. No tags = catch-all template.</div>
      <div class="example">Format: tags | reply text\n\ngm, good morning | gm fren, how's your bag?\nchart, ta | nice setup, what's your stop?\nbullish, bought | based, what's your target?\nbig news for the space</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="wizardBack()">Back</button>
      <button class="btn btn-primary" onclick="saveWizardTemplates()">Next</button>
    </div>
  `;
}
function saveWizardTemplates() {
  const v = document.getElementById('w-templates')?.value || '';
  wizardState.data.templates = v.split('\n').map(s => s.trim()).filter(Boolean);
  wizardNext();
}

function wizardPersona() {
  const presets = state.personas || [];
  const presetBtns = Object.entries(presets).map(([key, p]) =>
    `<div class="tag ${wizardState.data.personaPreset === key ? 'active' : ''}" onclick="pickPersonaPreset('${key}')">${p.name || key}</div>`
  ).join('');

  return `
    <div class="wizard-title">Persona</div>
    <div class="wizard-subtitle">Choose how the bot sounds. Persona drives AI voice fidelity.</div>
    ${presetBtns ? `<div class="field"><label>Presets (tap to select)</label><div class="tag-list">${presetBtns}</div></div>` : ''}
    <div class="field">
      <label>Or create custom</label>
      <input type="text" id="w-persona-name" placeholder="Name (e.g. Alex)" value="${wizardState.data.personaName || ''}">
    </div>
    <div class="field">
      <input type="text" id="w-persona-bio" placeholder="Bio (e.g. trader since 2017)" value="${wizardState.data.personaBio || ''}">
    </div>
    <div class="field">
      <input type="text" id="w-persona-style" placeholder="Style (e.g. cynical, lowercase, dry humor)" value="${wizardState.data.personaStyle || ''}">
      <div class="hint">With AI key set, the bot will rewrite templates in this voice.</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="wizardBack()">Back</button>
      <button class="btn btn-primary" onclick="saveWizardPersona()">Next</button>
    </div>
  `;
}
function pickPersonaPreset(key) {
  wizardState.data.personaPreset = key;
  const p = state.personas[key];
  if (p) {
    wizardState.data.persona = p;
    wizardState.data.personaName = p.name || '';
    wizardState.data.personaBio = p.bio || '';
    wizardState.data.personaStyle = p.style || '';
  }
  renderWizardStep();
}
function saveWizardPersona() {
  const name = document.getElementById('w-persona-name')?.value?.trim();
  const bio = document.getElementById('w-persona-bio')?.value?.trim();
  const style = document.getElementById('w-persona-style')?.value?.trim();
  if (name || bio || style) {
    wizardState.data.persona = { name, bio, style, examples: wizardState.data.persona?.examples || [] };
  }
  wizardNext();
}


function wizardPacing() {
  const presetKeys = Object.keys(state.presets || {});
  const selected = wizardState.data.preset || 'safe';
  const presetInfo = state.presets || {};

  return `
    <div class="wizard-title">Pacing Preset</div>
    <div class="wizard-subtitle">How fast should the bot reply? Start safe on new accounts.</div>
    ${presetKeys.map(k => {
      const p = presetInfo[k];
      const isSelected = k === selected;
      return `
        <div class="card ${isSelected ? 'selected' : ''}" style="cursor:pointer;" onclick="pickPacing('${k}')">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="text-transform:uppercase; letter-spacing:0.12em; font-size:14px;">${k}</strong>
            ${isSelected ? '<span style="color:var(--neon); font-size:11px; letter-spacing:0.18em; text-transform:uppercase;">Selected</span>' : ''}
          </div>
          <div class="sub" style="margin-top:6px;">${p.maxRepliesPerHour}/h · delay ${p.minDelaySec}-${p.maxDelaySec}s</div>
        </div>
      `;
    }).join('')}
    <div class="hint" style="margin-top:8px;">
      safe = ~170/day (new accounts) · medium = ~510/day · highvolume = ~1000/day (risky!)
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="wizardBack()">Back</button>
      <button class="btn btn-primary" onclick="wizardNext()">Next</button>
    </div>
  `;
}
function pickPacing(key) {
  wizardState.data.preset = key;
  renderWizardStep();
}

function wizardConfirm() {
  const d = wizardState.data;
  const handle = state.status?.handle || '?';
  return `
    <div class="wizard-title">Confirm & Create</div>
    <div class="wizard-subtitle">Review your campaign for @${handle}</div>
    <div class="card">
      <h3>Name</h3>
      <p>${d.name || '(unnamed)'}</p>
    </div>
    <div class="card">
      <h3>Keywords</h3>
      <p>${(d.keywords || []).join(', ') || '(match everything)'}</p>
    </div>
    <div class="card">
      <h3>Templates</h3>
      <p style="font-size:12px; white-space:pre-wrap;">${(d.templates || []).join('\n') || '(AI-only, no templates)'}</p>
    </div>
    <div class="card">
      <h3>Persona</h3>
      <p>${d.persona?.name || '(neutral default)'} ${d.persona?.style ? '— ' + d.persona.style : ''}</p>
    </div>
    <div class="card">
      <h3>Pacing</h3>
      <p style="text-transform:capitalize;">${d.preset || 'safe'}</p>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="wizardBack()">Back</button>
      <button class="btn btn-success btn-cta" onclick="submitWizard()">Create Campaign</button>
    </div>
  `;
}


async function submitWizard() {
  const d = wizardState.data;
  try {
    const res = await post('/campaign', {
      name: d.name,
      keywords: d.keywords || [],
      templates: d.templates || [],
      persona: d.persona || null,
      preset: d.preset || 'safe',
    });
    if (res.error) { toast(res.error); return; }
    toast('Campaign created!');
    // Refresh
    const campaignsRes = await get('/campaigns');
    state.campaigns = campaignsRes.campaigns || [];
    showDashboard();
  } catch (e) {
    toast('Error creating campaign');
  }
}


// ---------- Tune screen (Settings + AI combined) ----------
async function showSettings() {
  const c = state.currentCampaign;
  if (!c) { toast('No campaign selected'); return; }
  const cfg = c.config || {};
  const pacing = cfg.pacing || {};
  const filters = cfg.filters || {};
  const ratio = pacing.commenterRatio ?? 0.5;
  const nicheKw = (filters.whaleNicheKeywords || []).join(', ');

  // Fetch AI settings
  let aiSettings = [];
  try {
    const res = await get('/settings');
    aiSettings = res.settings || [];
  } catch {}
  const getAiVal = (key) => { const s = aiSettings.find(x => x.key === key); return s ? s.value : ''; };
  const hasKey = aiSettings.find(x => x.key === 'OPENAI_API_KEY')?.hasValue;

  render(`
    <div id="settings" class="screen active">
      <div class="wizard-title">Tune</div>
      <div class="wizard-subtitle">${c.name} (@${c.handle})</div>

      <div class="section-title">Campaign</div>

      <div class="card">
        <h3>Keywords</h3>
        <div class="field">
          <textarea id="s-keywords" rows="4">${(cfg.keywords || []).join('\n')}</textarea>
          <div class="hint">One per line. Empty = match all feed tweets.</div>
        </div>
      </div>

      <div class="card">
        <h3>Templates</h3>
        <div class="field">
          <textarea id="s-templates" rows="4">${formatTemplates(cfg.templates)}</textarea>
          <div class="hint">Format: tags | text (one per line)</div>
        </div>
      </div>

      <div class="card">
        <h3>Commenter / Feed Balance</h3>
        <div class="slider-container">
          <span style="font-size:11px;">Feed</span>
          <input type="range" id="s-ratio" min="0" max="100" value="${Math.round(ratio * 100)}" oninput="updateRatioLabel()">
          <span style="font-size:11px;">Commenters</span>
        </div>
        <div class="slider-val" id="ratio-label" style="text-align:center; margin-top:4px;">${Math.round(ratio * 100)}% commenters / ${Math.round((1 - ratio) * 100)}% feed</div>
        <div class="hint">50/50 recommended. Higher = more replies under whale posts.</div>
      </div>

      <div class="card">
        <h3>Whale Niche Filter</h3>
        <div class="field">
          <textarea id="s-niche" rows="2" placeholder="crypto, btc, solana...">${nicheKw}</textarea>
          <div class="hint">Only reply under whales whose post/bio matches these. Empty = all whales.</div>
        </div>
      </div>

      <div class="card">
        <h3>Pacing Preset</h3>
        <div class="field">
          <select id="s-preset" onchange="updatePresetInfo()">
            ${Object.keys(state.presets || {}).map(k =>
              `<option value="${k}" ${k === getPresetName(pacing) ? 'selected' : ''}>${k} (${state.presets[k].maxRepliesPerHour}/h)</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <div class="card">
        <h3>Filters</h3>
        <div class="field">
          <label>Min author followers</label>
          <input type="number" id="s-minFollowers" value="${filters.minAuthorFollowers || 0}">
        </div>
        <div class="field">
          <label>Min likes</label>
          <input type="number" id="s-minLikes" value="${filters.minLikes || 0}">
        </div>
        <div class="field">
          <label>Languages (comma-separated)</label>
          <input type="text" id="s-langs" value="${(filters.langs || []).join(', ')}">
        </div>
      </div>

      <button class="btn btn-success" onclick="saveSettings()">Save Campaign</button>

      <div class="section-title" style="margin-top:28px;">AI Engine</div>

      <div class="card ${hasKey ? 'success-card' : 'warn-card'}">
        <h3>Status</h3>
        <p>${hasKey ? '✅ AI active — persona-aware replies' : '⚠️ No AI key — using literal templates'}</p>
      </div>

      <div class="card">
        <h3>API Key</h3>
        <div class="field">
          <input type="password" id="ai-key" placeholder="sk-..." value="">
          <div class="hint">OpenAI, Groq, or compatible. Current: ${getAiVal('OPENAI_API_KEY') || 'not set'}</div>
        </div>
      </div>

      <div class="card">
        <h3>Model</h3>
        <div class="field">
          <input type="text" id="ai-model" placeholder="gpt-4o" value="${getAiVal('OPENAI_MODEL') || ''}">
          <div class="hint">e.g. gpt-4o, llama-3.3-70b-versatile</div>
        </div>
      </div>

      <div class="card">
        <h3>Base URL</h3>
        <div class="field">
          <input type="text" id="ai-url" placeholder="https://api.openai.com/v1" value="${getAiVal('OPENAI_BASE_URL') || ''}">
          <div class="hint">For Groq: https://api.groq.com/openai/v1</div>
        </div>
      </div>

      <button class="btn btn-success" onclick="saveAiSettings()">Save AI</button>
      <div style="height:12px;"></div>
      <button class="btn btn-outline" onclick="showDashboard()">Back to Dashboard</button>

      ${renderNav('tune')}
    </div>
  `);
}

function updateRatioLabel() {
  const v = document.getElementById('s-ratio').value;
  document.getElementById('ratio-label').textContent = `${v}% commenters / ${100 - v}% feed`;
}

function getPresetName(pacing) {
  for (const [k, p] of Object.entries(state.presets || {})) {
    if (p.maxRepliesPerHour === pacing.maxRepliesPerHour && p.minDelaySec === pacing.minDelaySec) return k;
  }
  return 'safe';
}

function formatTemplates(templates) {
  if (!Array.isArray(templates)) return '';
  return templates.map(t => {
    if (typeof t === 'string') return t;
    if (t && t.text) {
      const tags = (t.match || []).join(', ');
      return tags ? `${tags} | ${t.text}` : t.text;
    }
    return '';
  }).join('\n');
}


async function saveSettings() {
  const c = state.currentCampaign;
  if (!c) return;

  const keywords = (document.getElementById('s-keywords')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const templates = (document.getElementById('s-templates')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const ratio = (document.getElementById('s-ratio')?.value || 50) / 100;
  const nicheRaw = document.getElementById('s-niche')?.value || '';
  const nicheKw = nicheRaw.split(',').map(s => s.trim()).filter(Boolean);
  const preset = document.getElementById('s-preset')?.value;
  const minFollowers = parseInt(document.getElementById('s-minFollowers')?.value) || 0;
  const minLikes = parseInt(document.getElementById('s-minLikes')?.value) || 0;
  const langs = (document.getElementById('s-langs')?.value || '').split(',').map(s => s.trim()).filter(Boolean);

  try {
    await put(`/campaign/${c.id}/config`, {
      keywords,
      templates,
      preset: preset || undefined,
      pacing: { commenterRatio: ratio },
      filters: { whaleNicheKeywords: nicheKw, minAuthorFollowers: minFollowers, minLikes, langs },
    });
    toast('Settings saved!');
    // Refresh campaign data
    const res = await get(`/campaign/${c.id}`);
    state.currentCampaign = res;
    const idx = state.campaigns.findIndex(x => x.id === c.id);
    if (idx >= 0) state.campaigns[idx] = res;
  } catch (e) {
    toast('Error saving settings');
  }
}


async function saveAiSettings() {
  const key = document.getElementById('ai-key')?.value?.trim();
  const model = document.getElementById('ai-model')?.value?.trim();
  const url = document.getElementById('ai-url')?.value?.trim();

  const body = {};
  if (key) body.OPENAI_API_KEY = key;
  if (model) body.OPENAI_MODEL = model;
  else body.OPENAI_MODEL = '';
  if (url) body.OPENAI_BASE_URL = url;
  else body.OPENAI_BASE_URL = '';

  try {
    await put('/settings', body);
    toast('AI settings saved!');
  } catch {
    toast('Error saving');
  }
}


// ---------- Growth screen ----------
async function showGrowth() {
  const c = state.currentCampaign;
  if (!c) { toast('No campaign selected'); return; }

  // Fetch stats from API (graceful fallback if endpoint doesn't exist yet)
  let growth = { followersGained: 0, followBackRate: 0, bestHours: [], totalImpressions: 0, topReplies: [] };
  try {
    const res = await get(`/campaign/${c.id}/growth`);
    if (res && !res.error) growth = res;
  } catch {}

  const bestHoursText = growth.bestHours?.length
    ? growth.bestHours.map(h => `${h}:00`).join(', ')
    : 'Collecting data...';

  render(`
    <div id="growth" class="screen active">
      <div class="wizard-title">Growth</div>
      <div class="wizard-subtitle">Auto-tracked engagement metrics for @${c.handle}</div>

      <div class="hero-card">
        <div class="label">Follow-back rate</div>
        <div class="big">${growth.followBackRate || 0}%</div>
        <div class="small">replies that converted to follows</div>
      </div>

      <div class="stats-row" style="margin-top:12px;">
        <div class="card">
          <h3>Followers gained</h3>
          <div class="value">${growth.followersGained || 0}</div>
          <div class="sub">this week</div>
        </div>
        <div class="card">
          <h3>Impressions</h3>
          <div class="value">${growth.totalImpressions || 0}</div>
          <div class="sub">from replies</div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <h3>Best performing hours</h3>
        <p style="font-size:15px; font-weight:700; color:var(--green);">${bestHoursText}</p>
        <div class="sub">Bot auto-adjusts activity to these windows</div>
      </div>

      ${growth.topReplies?.length ? `
        <div class="section-title">Top replies this week</div>
        ${growth.topReplies.slice(0, 5).map(r => `
          <div class="card">
            <p style="font-size:13px;">${escHtml(r.text || '')}</p>
            <div class="sub" style="margin-top:6px;">❤️ ${r.likes || 0} &middot; 🔁 ${r.retweets || 0} &middot; replied to @${r.target || '?'}</div>
          </div>
        `).join('')}
      ` : `
        <div class="card" style="margin-top:12px;">
          <h3>Top replies</h3>
          <p style="color:var(--text-3);">Will appear after first 24h of activity</p>
        </div>
      `}

      ${renderNav('growth')}
    </div>
  `);
}


// ---------- Queue screen ----------
async function showQueue() {
  const c = state.currentCampaign;
  if (!c) { toast('No campaign selected'); return; }

  let queue = { recent: [], autoDisabled: [] };
  try {
    const res = await get(`/campaign/${c.id}/queue`);
    if (res && !res.error) queue = res;
  } catch {}

  render(`
    <div id="queue" class="screen active">
      <div class="wizard-title">Queue</div>
      <div class="wizard-subtitle">Recent replies sent by bot &middot; auto quality tracking</div>

      ${queue.autoDisabled?.length ? `
        <div class="card warn-card">
          <h3>Auto-disabled templates</h3>
          <p style="font-size:13px;">These templates got 0 engagement after 20+ uses and were automatically paused:</p>
          <div style="margin-top:8px;">
            ${queue.autoDisabled.map(t => `<div style="font-size:12px; color:var(--text-3); padding:4px 0; border-bottom:1px solid var(--line);">${escHtml(t)}</div>`).join('')}
          </div>
        </div>
      ` : ''}

      <div class="section-title">Last 20 replies</div>
      ${queue.recent?.length ? queue.recent.map(r => {
        const scoreColor = r.score >= 7 ? 'var(--green)' : r.score >= 4 ? 'var(--warn)' : 'var(--danger)';
        const time = r.ts ? new Date(r.ts).toLocaleTimeString() : '';
        return `
          <div class="card" style="padding:14px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <p style="font-size:13px; flex:1;">${escHtml(r.text || '')}</p>
              <span style="font-size:11px; font-weight:700; color:${scoreColor}; white-space:nowrap;">${r.score != null ? r.score + '/10' : '—'}</span>
            </div>
            <div class="sub" style="margin-top:6px;">→ @${r.target || '?'} &middot; ${time}${r.likes ? ' &middot; ❤️' + r.likes : ''}</div>
          </div>
        `;
      }).join('') : `
        <div class="card">
          <p style="color:var(--text-3);">No replies sent yet. Start campaign to see activity here.</p>
        </div>
      `}

      ${renderNav('queue')}
    </div>
  `);
}


// ---------- Logs screen ----------
async function showLogs() {
  const c = state.currentCampaign;
  if (!c) { toast('No campaign selected'); return; }

  let logs = [];
  try {
    const res = await get(`/campaign/${c.id}/logs`);
    logs = res.logs || [];
  } catch {}

  render(`
    <div id="logs-screen" class="screen active">
      <div class="wizard-title">Logs</div>
      <div class="wizard-subtitle">${c.name} (@${c.handle}) — last 50 entries</div>

      <div class="log-list">
        ${logs.length === 0 ? '<p style="color:var(--hint);">(no logs yet)</p>' : ''}
        ${logs.map(l => {
          const time = new Date(l.ts).toLocaleTimeString();
          const lvlClass = l.level === 'error' ? 'lvl-error' : l.level === 'warn' ? 'lvl-warn' : '';
          return `<div class="log-item"><span class="ts">${time}</span> <span class="${lvlClass}">[${l.level}]</span> ${escHtml(l.msg)}</div>`;
        }).join('')}
      </div>

      <button class="btn btn-outline" style="margin-top:16px;" onclick="showLogs()">Refresh</button>
      <div style="height:8px;"></div>
      <button class="btn btn-outline" onclick="showDashboard()">Back</button>

      ${renderNav('logs')}
    </div>
  `);
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------- Campaign detail ----------
function showCampaignDetail() {
  const c = state.currentCampaign;
  if (!c) return showDashboard();
  // Just redirect to settings with this campaign selected
  showSettings();
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', init);
