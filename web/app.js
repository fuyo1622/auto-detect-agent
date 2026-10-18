// Agent Monitor: the iPhone app, and the dashboard at http://127.0.0.1:7421 on the PC.
const TOKEN_KEY = 'agentMonitor.token';
const STATE_KEY = 'agentMonitor.lastState';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function storeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storeSet(k, v) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: the app still works for this visit */
  }
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

const S = {
  token: storeGet(TOKEN_KEY),
  who: null,
  state: null,
  skew: 0,
  conn: 'connecting',
  lastOk: 0,
  tab: 'sessions',
  filter: 'all',
  sheet: null,
  sheetId: 0,
  renderedSheetId: -1,
  toast: null,
  pairCode: '',
  pairHere: false,
  pc: null,
  devices: null,
  busy: new Set(),
  sig: '',
};

const ICON = {
  refresh:
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  pulse:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-7 4 14 3-7h6"/></svg>',
  sliders:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  pc: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  ext: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>',
  more: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  share:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  close:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

const HEALTH = {
  dead: 'Stopped unexpectedly',
  'rc-lost': 'Remote Control lost',
  working: 'Working',
  waiting: 'Waiting for you',
  ended: 'Closed',
};
const PROBLEMS = new Set(['dead', 'rc-lost']);
const BANNER_TEXT = { 'rc-lost': 'lost Remote Control', dead: 'stopped unexpectedly' };

// ---------------------------------------------------------------- utilities

function now() {
  return Date.now() + S.skew;
}

function ago(t, base = now()) {
  if (!t) return '';
  const s = Math.max(0, (base - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function clock(t) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date(now()).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function whereLabel(v) {
  return v.host === 'cli' ? 'Terminal' : 'Claude app';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Agent-Client': 'web' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `The PC answered ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(text, kind = 'ok') {
  const id = Math.random();
  S.toast = { text, kind, id };
  renderToast();
  setTimeout(() => {
    if (S.toast?.id === id) {
      S.toast = null;
      renderToast();
    }
  }, kind === 'error' ? 6000 : 4000);
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- actions

function actionInfo(v, action) {
  switch (action) {
    case 'reconnect': {
      // Without Remote Control the same restart is how you turn it on.
      const turnOn = !v.rc.expected && v.rc.state !== 'on';
      return {
        label: turnOn ? 'Turn on Remote Control' : 'Reconnect',
        desc: 'Close this process and reopen the same conversation in a new Windows Terminal tab with Remote Control on.',
        confirm: `The process running “${v.title}” is closed and the conversation reopens in a new Windows Terminal tab with Remote Control on. The conversation is kept.`,
      };
    }
    case 'resume':
      return { label: 'Resume', desc: 'Open the conversation again in a new Windows Terminal tab with Remote Control on.' };
    case 'restart-app':
      return {
        label: 'Restart Claude app',
        desc: 'Close and reopen the Claude app. Every session inside it restarts.',
        confirm: 'Restart the Claude app? Every session inside it restarts.',
        danger: true,
      };
    case 'start-app':
      return { label: 'Open Claude app', desc: 'Start the Claude app on the PC.' };
    case 'dismiss':
      return { label: 'Dismiss', desc: 'Hide this closed session from the list.' };
    default:
      return { label: action, desc: '' };
  }
}

const APP_ACTIONS = {
  restart: (a) => ({
    label: `Restart ${a.name}`,
    desc: `Close and reopen the ${a.name}. Every session inside it restarts.`,
    confirm: `Restart the ${a.name}? Every session inside it restarts.`,
    danger: true,
  }),
  start: (a) => ({ label: `Open ${a.name}`, desc: `Start the ${a.name} on the PC.` }),
};

function primaryAction(v) {
  if (v.health === 'rc-lost') return ['reconnect', 'restart-app'].find((a) => v.actions.includes(a));
  if (v.health === 'dead' || v.health === 'ended') return ['resume', 'start-app'].find((a) => v.actions.includes(a));
  return undefined;
}

async function sessionAction(key, action, { confirmed = false, force = false } = {}) {
  const v = S.state?.sessions.find((s) => s.key === key);
  if (!v) return toast('That session is no longer listed.', 'error');
  const info = actionInfo(v, action);
  const needsConfirm = info.confirm && !confirmed && (action !== 'reconnect' || v.alive);
  if (needsConfirm) {
    return openSheet({ type: 'confirm', title: `${info.label}?`, text: info.confirm, yes: info.label, danger: info.danger, run: { kind: 'session', key, action } });
  }
  closeSheet();
  S.busy.add(key);
  renderMain();
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(key)}/${action}`, { method: 'POST', body: { force } });
    if (r.needsConfirm) {
      return openSheet({ type: 'confirm', title: 'Are you sure?', text: r.message, yes: info.label, danger: true, run: { kind: 'session', key, action, force: true } });
    }
    toast(r.message, r.ok ? 'ok' : 'error');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    S.busy.delete(key);
    renderMain();
  }
}

async function appAction(id, action, { confirmed = false, force = false } = {}) {
  const a = S.state?.apps.find((x) => x.id === id);
  if (!a) return;
  const info = APP_ACTIONS[action](a);
  if (info.confirm && !confirmed) {
    return openSheet({ type: 'confirm', title: `${info.label}?`, text: info.confirm, yes: info.label, danger: info.danger, run: { kind: 'app', id, action } });
  }
  closeSheet();
  S.busy.add(`app:${id}`);
  renderMain();
  try {
    const r = await api(`/api/apps/${id}/${action}`, { method: 'POST', body: { force } });
    if (r.needsConfirm) {
      return openSheet({ type: 'confirm', title: 'Are you sure?', text: r.message, yes: info.label, danger: true, run: { kind: 'app', id, action, force: true } });
    }
    toast(r.message, r.ok ? 'ok' : 'error');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    S.busy.delete(`app:${id}`);
    renderMain();
  }
}

// ---------------------------------------------------------------- live updates

let stream = null;
let lastEventAt = 0;
let retryDelay = 1000;
let retryTimer = null;

async function connect() {
  if (stream) stream.abort();
  clearTimeout(retryTimer);
  const ctrl = new AbortController();
  stream = ctrl;
  if (S.conn !== 'live') {
    S.conn = 'connecting';
    renderHeader();
  }
  try {
    const headers = S.token ? { Authorization: `Bearer ${S.token}` } : {};
    const res = await fetch('/api/events', { headers, signal: ctrl.signal, cache: 'no-store' });
    if (res.status === 401) return unpaired('This phone was unpaired on the PC. Pair it again.');
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastEventAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        onEvent(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    throw new Error('stream closed');
  } catch {
    if (stream !== ctrl) return; // replaced by a newer connection
    S.conn = 'offline';
    renderHeader();
    renderMain();
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }
}

function onEvent(block) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (event === 'state' && data) setState(JSON.parse(data));
}

let whoLoading = false;

function setState(st) {
  // Started offline: learn who we are once the PC answers.
  if (!S.who && !whoLoading) {
    whoLoading = true;
    api('/api/whoami')
      .then((w) => {
        S.who = w;
        render();
      })
      .catch(() => {})
      .finally(() => (whoLoading = false));
  }
  const wasLive = S.conn === 'live';
  S.state = st;
  S.skew = st.agent.now - Date.now();
  S.conn = 'live';
  S.lastOk = Date.now();
  retryDelay = 1000;
  const sig = JSON.stringify([st.sessions, st.apps, st.activity, st.agent.settings, st.agent.awake, st.agent.publicUrl, st.agent.helper]);
  storeSet(STATE_KEY, JSON.stringify(st));
  if (!wasLive) renderHeader();
  if (sig === S.sig) return;
  S.sig = sig;
  liveRender();
}

// Live updates redraw the list and the open sheet. A tap that lands while the button under the
// finger is being replaced is lost, so hold those redraws while a finger (or mouse button) is down.
let pressing = false;
let pressEndedAt = 0;
let deferred = false;

function holding() {
  return pressing || Date.now() - pressEndedAt < 400;
}

document.addEventListener('pointerdown', () => (pressing = true), true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(
    type,
    () => {
      pressing = false;
      pressEndedAt = Date.now();
      if (deferred) setTimeout(liveRender, 450); // after the click has been handled
    },
    true,
  );
}

function liveRender() {
  if (holding()) {
    deferred = true;
    return;
  }
  deferred = false;
  renderHeader();
  renderTabs();
  if (S.tab === 'sessions') renderMain();
  if (S.sheet && S.sheet.type !== 'confirm') renderSheet();
}

// Reconnect when a connection silently died (phone slept, network switched).
setInterval(() => {
  if (!paired() || document.hidden) return;
  if (S.conn === 'live' && Date.now() - lastEventAt > 40000) connect();
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && paired() && Date.now() - lastEventAt > 20000) {
    retryDelay = 1000;
    connect();
  }
});
addEventListener('online', () => paired() && connect());
setInterval(() => {
  if (!paired() || holding()) return;
  renderHeader();
  if (S.tab === 'sessions' && !S.sheet) renderMain();
}, 30000);

// ---------------------------------------------------------------- rendering

function paired() {
  return !!(S.who?.admin || S.token);
}

function render() {
  renderHeader();
  renderMain();
  renderTabs();
  renderSheet();
  renderToast();
}

function renderToast() {
  const t = S.toast;
  $('#toast').innerHTML = t ? `<div class="toast ${t.kind === 'error' ? 'error' : ''}" role="status">${esc(t.text)}</div>` : '';
}

function renderHeader() {
  const el = $('#hdr');
  if (!paired()) {
    el.innerHTML = '';
    return;
  }
  const host = S.state?.agent.host || S.who?.host || 'your PC';
  const text =
    S.conn === 'live' ? 'Live' : S.conn === 'connecting' ? 'Connecting…' : `Offline${S.lastOk ? ` · updated ${ago(S.lastOk, Date.now())}` : ''}`;
  const title = S.tab === 'settings' ? 'Settings' : S.tab === 'pc' ? 'Phone setup' : 'Agents';
  el.innerHTML = `
    <div class="hdr-row">
      <div style="min-width:0">
        <h1 class="hdr-title">${title}</h1>
        <div class="hdr-sub"><span class="conn ${S.conn}"></span><span>${esc(host)} · ${esc(text)}</span></div>
      </div>
      <button class="icon-btn" data-act="refresh" aria-label="Refresh">${ICON.refresh}</button>
    </div>`;
}

function renderTabs() {
  const el = $('#tabs');
  if (!paired()) {
    el.innerHTML = '';
    return;
  }
  const problems = S.state ? S.state.sessions.filter((s) => PROBLEMS.has(s.health)).length : 0;
  const tab = (id, icon, label, badge) =>
    `<button class="tab ${S.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}" aria-current="${S.tab === id}">
      ${icon}<span>${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</button>`;
  el.innerHTML = `<div class="tabs-inner">
    ${tab('sessions', ICON.pulse, 'Sessions', problems)}
    ${S.who?.admin ? tab('pc', ICON.pc, 'Phone setup') : ''}
    ${tab('settings', ICON.sliders, 'Settings')}
  </div>`;
}

function renderMain() {
  const el = $('#main');
  if (!paired()) {
    el.innerHTML = pairingHtml();
    return;
  }
  if (S.tab === 'settings') el.innerHTML = settingsHtml();
  else if (S.tab === 'pc') el.innerHTML = pcHtml();
  else el.innerHTML = sessionsHtml();
}

function sessionsHtml() {
  const st = S.state;
  if (!st) {
    return `<div class="boot">${S.conn === 'offline' ? 'Can’t reach your PC yet.' : 'Connecting to your PC…'}</div>${offlineBanner()}`;
  }
  const all = st.sessions;
  const problems = all.filter((s) => PROBLEMS.has(s.health));
  const counts = { all: all.length, attention: problems.length };
  if (S.filter === 'attention' && !counts.attention) S.filter = 'all';
  const filters = { all: () => true, attention: (s) => PROBLEMS.has(s.health) };
  const shown = all.filter(filters[S.filter] || filters.all);
  const chip = (id, label) =>
    counts[id] || id === 'all'
      ? `<button class="chip ${S.filter === id ? 'on' : ''}" data-act="filter" data-filter="${id}">${label}<span class="n">${counts[id]}</span></button>`
      : '';

  let banner = '';
  if (problems.length) {
    const byKind = ['rc-lost', 'dead']
      .map((h) => [h, problems.filter((s) => s.health === h).length])
      .filter(([, n]) => n)
      .map(([h, n]) => `${n} ${BANNER_TEXT[h]}`)
      .join(' · ');
    banner = `<div class="banner bad"><div><b>${problems.length} session${problems.length > 1 ? 's need' : ' needs'} attention</b>
      <span class="muted">${esc(byKind)}</span></div></div>`;
  }
  if (st.agent.helper === 'fallback') {
    banner += `<div class="banner info"><div><b>Running in slow mode</b><span class="muted">The process helper could not start on the PC, so updates are slower and some details are missing.</span></div></div>`;
  }

  const list = shown.length
    ? `<div class="list">${shown.map(cardHtml).join('')}</div>`
    : `<div class="empty"><b>No sessions</b>${S.filter === 'all' ? 'Start Claude Code on the PC and it shows up here.' : 'Nothing matches this filter.'}</div>`;

  return `${offlineBanner()}${banner}
    ${counts.attention ? `<div class="chips">${chip('all', 'All')}${chip('attention', 'Needs attention')}</div>` : ''}
    ${list}
    ${appsHtml(st.apps, st.agent.host)}
    ${activityHtml(st.activity)}`;
}

function offlineBanner() {
  if (S.conn !== 'offline') return '';
  const since = S.lastOk ? ` Last update ${ago(S.lastOk, Date.now())}.` : '';
  return `<div class="banner bad"><div><b>Can’t reach your PC</b><span class="muted">${since} The PC may be asleep or off, or Tailscale is off on the PC or on this phone. Retrying…</span></div></div>`;
}

/** Remote Control badge for running sessions (a lost connection already shows as the status). */
function rcChip(v) {
  if (!v.alive || v.health === 'rc-lost') return '';
  if (v.rc.state === 'on') return '<span class="rc-chip rc-on">Remote on</span>';
  return v.rc.expected ? '' : '<span class="rc-chip">No Remote Control</span>';
}

function cardHtml(v) {
  const primary = primaryAction(v);
  const busy = S.busy.has(v.key);
  const link = v.alive && v.rc?.url && v.rc.state !== 'off' ? v.rc.url : '';
  const showDetail = PROBLEMS.has(v.health);
  const folder = v.folder && v.folder !== v.title ? `<span class="sep">·</span><span>${esc(v.folder)}</span>` : '';
  const btns = [];
  if (primary) {
    btns.push(
      `<button class="btn primary grow ${busy ? 'busy' : ''}" data-act="sa" data-key="${esc(v.key)}" data-action="${primary}">${busy ? 'Working…' : esc(actionInfo(v, primary).label)}</button>`,
    );
  }
  if (link) btns.push(`<a class="btn ${primary ? '' : 'tinted'} grow" href="${esc(link)}" target="_blank" rel="noopener">Open in Claude ${ICON.ext}</a>`);
  btns.push(
    btns.length
      ? `<button class="btn more" data-act="open" data-key="${esc(v.key)}" aria-label="More actions">${ICON.more}</button>`
      : `<button class="btn grow" data-act="open" data-key="${esc(v.key)}">Actions</button>`,
  );
  return `<article class="card h-${v.health} ${v.alive ? '' : 'ended'}">
    <button class="card-tap" data-act="open" data-key="${esc(v.key)}">
      <div class="status"><span class="pulse"></span>${esc(HEALTH[v.health])}<span class="when">${esc(ago(v.lastActivityAt || v.startedAt || v.healthSince))}</span></div>
      <div class="title">${esc(v.title)}</div>
      <div class="meta"><span>${esc(whereLabel(v))}</span>${folder}${rcChip(v)}</div>
      ${showDetail ? `<div class="detail">${esc(v.detail)}</div>` : ''}
    </button>
    <div class="card-actions">${btns.join('')}</div>
  </article>`;
}

function appsHtml(apps, host) {
  if (!apps?.length) return '';
  const rows = apps
    .map((a) => {
      const busy = S.busy.has(`app:${a.id}`);
      const state = a.running ? 'Running' : a.installed ? 'Not running' : 'Not installed';
      const btn = a.actions.length
        ? `<button class="btn small ${busy ? 'busy' : ''}" data-act="app" data-app="${a.id}">${busy ? 'Working…' : a.running ? 'Manage' : 'Start'}</button>`
        : '';
      return `<div class="app-row"><span class="dot ${a.running ? 'on' : ''}"></span>
        <div class="name">${esc(a.name)}<small>${esc(state)}</small></div>${btn}</div>`;
    })
    .join('');
  return `<div class="label">Apps on ${esc(host)}</div><div class="apps">${rows}</div>`;
}

function activityHtml(list) {
  if (!list?.length) return '';
  const rows = list
    .slice(0, 6)
    .map(
      (a) => `<div class="act-row"><span class="${a.ok ? 'ok' : 'fail'}">${a.ok ? '✓' : '✕'}</span><div>${esc(a.message)}</div>
        <small>${esc(a.action)} · ${esc(a.by)} · ${esc(ago(a.at))}</small></div>`,
    )
    .join('');
  return `<div class="label">Recent actions</div><div class="activity">${rows}</div>`;
}

// ---------------------------------------------------------------- sheets

function openSheet(sheet) {
  S.sheet = sheet;
  S.sheetId++;
  renderSheet();
}

function closeSheet() {
  if (!S.sheet) return;
  S.sheet = null;
  renderSheet();
}

function renderSheet() {
  const root = $('#sheet');
  if (!S.sheet) {
    root.innerHTML = '';
    S.renderedSheetId = -1;
    return;
  }
  const body = sheetBody(S.sheet);
  const existing = root.querySelector('.sheet-body');
  if (existing && S.renderedSheetId === S.sheetId) {
    const scroller = root.querySelector('.sheet');
    const top = scroller.scrollTop;
    existing.innerHTML = body;
    scroller.scrollTop = top;
    return;
  }
  root.innerHTML = `<div class="backdrop" data-act="close"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div><div class="sheet-body">${body}</div></div>`;
  S.renderedSheetId = S.sheetId;
}

function sheetBody(sheet) {
  if (sheet.type === 'confirm') {
    return `<div class="confirm">
      <h2>${esc(sheet.title)}</h2><p>${esc(sheet.text)}</p>
      <div class="btns">
        <button class="btn block ${sheet.danger ? 'danger' : 'primary'}" data-act="confirm">${esc(sheet.yes)}</button>
        <button class="btn block" data-act="close">Cancel</button>
      </div></div>`;
  }
  if (sheet.type === 'app') {
    const a = S.state?.apps.find((x) => x.id === sheet.id);
    if (!a) return `<p>Not available.</p>`;
    const items = a.actions
      .map((act) => {
        const info = APP_ACTIONS[act](a);
        return `<button class="action-item ${info.danger ? 'danger' : ''}" data-act="aa" data-app="${a.id}" data-action="${act}"><b>${esc(info.label)}</b><span>${esc(info.desc)}</span></button>`;
      })
      .join('');
    return `<div class="sheet-head"><div class="status"><span class="dot ${a.running ? 'on' : ''}"></span> ${a.running ? 'Running' : 'Not running'}</div>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button></div>
      <h2>${esc(a.name)}</h2>
      <div class="action-list">${items}</div>`;
  }
  const v = S.state?.sessions.find((s) => s.key === sheet.key);
  if (!v) {
    return `<div class="sheet-head"><div class="status">Session</div><button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button></div>
      <p class="empty">This session is no longer listed.</p>`;
  }
  const busy = S.busy.has(v.key);
  const rcText =
    v.rc.state === 'on'
      ? 'Connected'
      : v.rc.state === 'off'
        ? v.rc.expected ? 'Not connected' : 'Off'
        : v.rc.state === 'unknown' ? 'Unknown (Claude no longer lists this session)' : 'Session closed';
  const facts = [
    ['Status', `${HEALTH[v.health]} since ${clock(v.healthSince)}`],
    ['Where', whereLabel(v)],
    v.cwd ? ['Folder', `<span class="mono">${esc(v.cwd)}</span>`, true] : null,
    ['Remote Control', v.rc.url ? `${esc(rcText)} · <a href="${esc(v.rc.url)}" target="_blank" rel="noopener">link</a>` : esc(rcText), true],
    ['Last activity', `${clock(v.lastActivityAt)} (${ago(v.lastActivityAt)})`],
    ['Started', clock(v.startedAt)],
  ].filter(Boolean);
  const factsHtml = facts.map(([k, val, raw]) => `<div><dt>${esc(k)}</dt><dd>${raw ? val : esc(val)}</dd></div>`).join('');
  const primary = primaryAction(v);
  const items = [];
  const link = v.alive && v.rc?.url && v.rc.state !== 'off' ? v.rc.url : '';
  if (link) {
    items.push(`<a class="action-item ${primary ? '' : 'primary'}" href="${esc(link)}" target="_blank" rel="noopener"><b>Open in Claude ${ICON.ext}</b><span>Continue this session on your phone through Remote Control.</span></a>`);
  }
  for (const act of v.actions) {
    const info = actionInfo(v, act);
    const cls = act === primary ? 'primary' : info.danger ? 'danger' : '';
    items.push(
      `<button class="action-item ${cls} ${busy ? 'busy' : ''}" data-act="sa" data-key="${esc(v.key)}" data-action="${act}"><b>${esc(info.label)}</b><span>${esc(info.desc)}</span></button>`,
    );
  }
  return `<div class="sheet-head h-${v.health}"><div class="status"><span class="pulse"></span>${esc(HEALTH[v.health])}</div>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button></div>
    <h2>${esc(v.title)}</h2>
    <div class="h-${v.health}"><div class="detail">${esc(v.detail)}</div></div>
    <div class="action-list">${items.join('')}</div>
    <dl class="facts">${factsHtml}</dl>`;
}

// ---------------------------------------------------------------- settings

function settingsHtml() {
  const st = S.state;
  const settings = st?.agent.settings;
  const device = S.who?.device;
  let notify;
  if (S.who?.admin) {
    notify = `<div class="row"><div class="grow">Phone notifications are set up on the phone, in its Settings tab.<small>On this PC, problems also pop up from the tray icon.</small></div></div>
      <div class="row"><button class="btn small" data-act="push-test-all">Send a test to all phones</button></div>`;
  } else if (!pushSupported()) {
    notify = `<div class="row"><div class="grow">${
      isIOS && !isStandalone
        ? `Add this app to your Home Screen first (tap ${ICON.share} then <b>Add to Home Screen</b>), then open it from there to turn on notifications.`
        : 'This browser can’t receive notifications. On iPhone, open the app from your Home Screen (iOS 16.4 or later).'
    }</div></div>`;
  } else if (!device?.push) {
    notify = `<div class="row"><div class="grow">Get an alert when Remote Control drops or a session stops unexpectedly.</div></div>
      <div class="row"><button class="btn primary block" data-act="push-on">Turn on notifications</button></div>`;
  } else {
    const p = device.prefs || {};
    const toggle = (id, label, help) => `<div class="row"><div class="grow">${label}<small>${help}</small></div>
      <label class="toggle"><input type="checkbox" data-act="pref" data-pref="${id}" ${p[id] ? 'checked' : ''}><span></span><span class="sr">${label}</span></label></div>`;
    notify = `${toggle('problems', 'Problems', 'Remote Control lost, or a session stopped unexpectedly')}
      ${toggle('system', 'PC status', 'The PC woke up or came back online')}
      <div class="row"><button class="btn small" data-act="push-test">Send a test</button><span class="grow"></span><button class="btn small danger" data-act="push-off">Turn off</button></div>`;
  }

  const awake = settings?.keepAwake ?? 'off';
  const seg = (id, label) => `<button class="${awake === id ? 'on' : ''}" data-act="awake" data-mode="${id}">${label}</button>`;

  const pcGroup = settings
    ? `<div class="label">On the PC</div>
      <div class="group">
        <div class="row"><div class="grow">Keep the PC awake<small>${st.agent.awake ? 'Active now: the PC won’t sleep on its own.' : 'Stops Windows from sleeping by itself, so sessions stay reachable.'}</small></div></div>
        <div class="segmented">${seg('off', 'Off')}${seg('while-working', 'While working')}${seg('always', 'Always')}</div>
        <div class="row"><div class="grow">Auto-reconnect<small>When a terminal session loses Remote Control and is idle, reopen it with Remote Control after 2 minutes (at most 3 times an hour).</small></div>
          <label class="toggle"><input type="checkbox" data-act="auto" ${settings.autoReconnect ? 'checked' : ''}><span></span><span class="sr">Auto-reconnect</span></label></div>
      </div>
      <p class="help">“Always” or “While working” keeps the PC on but lets the screen turn off. Closing the lid or choosing Sleep still puts it to sleep.</p>`
    : '';

  const phoneGroup = device
    ? `<div class="label">This phone</div>
      <div class="group">
        <div class="row"><div class="grow">${esc(device.name)}<small>Paired ${esc(clock(device.createdAt))}</small></div></div>
        <div class="row"><button class="btn small danger" data-act="unpair">Unpair this phone</button></div>
      </div>`
    : '';

  return `<div class="label">Notifications</div><div class="group">${notify}</div>
    ${pcGroup}${phoneGroup}
    <p class="help" style="margin-top:22px">Agent Monitor ${esc(st?.agent.version || S.who?.version || '')} on ${esc(st?.agent.host || S.who?.host || '')}${
      st?.agent.publicUrl ? ` · ${esc(st.agent.publicUrl)}` : ''
    }</p>`;
}

function pushSupported() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function pushOn() {
  if (!pushSupported()) return toast('Notifications aren’t available here.', 'error');
  // iOS only shows the permission prompt when it's requested straight from a tap.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return toast('Notifications are blocked. Allow them in iPhone Settings → Notifications → Agents.', 'error');
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    S.who.device = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    toast('Notifications are on.');
  } catch (e) {
    toast(`Couldn’t turn on notifications: ${e.message}`, 'error');
  }
  renderMain();
}

async function pushOff() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    /* the server side is what matters */
  }
  try {
    S.who.device = await api('/api/push/unsubscribe', { method: 'POST' });
    toast('Notifications are off.');
  } catch (e) {
    toast(e.message, 'error');
  }
  renderMain();
}

async function saveSettings(patch) {
  try {
    const settings = await api('/api/settings', { method: 'PATCH', body: patch });
    if (S.state) S.state.agent.settings = settings;
    toast('Saved.');
  } catch (e) {
    toast(e.message, 'error');
  }
  renderMain();
}

// ---------------------------------------------------------------- PC setup (dashboard only)

function pcHtml() {
  const p = S.pc;
  if (!p) return `<div class="boot">Loading…</div>`;
  const ts = p.tailscale || {};
  const mark = (ok) => `<span class="mark ${ok ? 'ok' : 'no'}">${ok ? '✓' : '!'}</span>`;
  const line = (ok, text, help = '') => `<div class="row status-line">${mark(ok)}<div class="grow">${text}${help ? `<small>${help}</small>` : ''}</div></div>`;
  let tsRows = line(ts.installed, ts.installed ? 'Tailscale is installed' : 'Install Tailscale on this PC', ts.installed ? '' : 'Download it from <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a> and sign in.');
  if (ts.installed) {
    tsRows += line(ts.running, ts.running ? `Signed in as ${esc(ts.dnsName || 'this PC')}` : 'Sign in to Tailscale', ts.running ? '' : `Tailscale says: ${esc(ts.state || 'not running')}. Open Tailscale from the tray and log in.`);
  }
  if (ts.running) {
    tsRows += ts.serving
      ? line(true, `Phone address is on: <b>${esc(ts.url)}</b>`, 'Only devices signed in to your Tailscale account can open it.')
      : `${line(false, 'Phone address is off', 'Makes the app reachable at an https address inside your tailnet (not the public internet).')}
         <div class="row"><button class="btn primary block" data-act="pc-serve">Turn on phone address</button></div>`;
  }
  const expiresIn = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  const code = `${p.code.slice(0, 3)} ${p.code.slice(3)}`;
  const pairBlock = p.link
    ? `<div class="pc-code"><div class="qr" aria-label="QR code">${p.qrSvg}</div>
        <div class="code-big">${code}</div><small class="help" id="pc-exp">Expires in ${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')}</small>
        <div style="margin-top:10px"><button class="btn small" data-act="pc-code">New code</button></div></div>`
    : `<div class="row"><div class="grow">The QR code appears once the phone address is on.<small>Code for later: <b>${code}</b></small></div></div>`;
  const devices = (S.devices || [])
    .map(
      (d) => `<div class="row"><div class="grow">${esc(d.name)}<small>Paired ${esc(clock(d.createdAt))} · last seen ${esc(ago(d.lastSeenAt, Date.now()))}${d.push ? ' · notifications on' : ''}</small></div>
        <button class="btn small danger" data-act="pc-remove" data-id="${esc(d.id)}">Remove</button></div>`,
    )
    .join('');
  return `<div class="label">1 · Phone address</div><div class="group">${tsRows}</div>
    <p class="help">Install Tailscale on the iPhone too and sign in with the same account.</p>
    <div class="label">2 · Pair the iPhone</div><div class="group">${pairBlock}</div>
    <ol class="steps">
      <li>Scan the QR code with the iPhone camera. It opens in Safari.</li>
      <li>Tap ${ICON.share} and choose <b>Add to Home Screen</b>.</li>
      <li>Open <b>Agents</b> from the Home Screen and enter the code.</li>
      <li>In the app’s Settings tab, turn on notifications.</li>
    </ol>
    <div class="label">Paired phones</div>
    <div class="group">${devices || '<div class="row"><div class="grow">No phone is paired yet.</div></div>'}
      ${S.devices?.length ? '<div class="row"><button class="btn small" data-act="push-test-all">Send a test notification</button></div>' : ''}</div>`;
}

async function loadPc(renew = false) {
  try {
    const [pc, devices] = await Promise.all([api('/api/admin/pairing', { method: renew ? 'POST' : 'GET' }), api('/api/admin/devices')]);
    S.pc = pc;
    S.devices = devices;
  } catch (e) {
    toast(e.message, 'error');
  }
  if (S.tab === 'pc') renderMain();
}

setInterval(() => {
  if (S.tab !== 'pc' || !S.pc) return;
  const left = Math.max(0, Math.round((S.pc.expiresAt - Date.now()) / 1000));
  if (left === 0) return loadPc();
  const el = $('#pc-exp');
  if (el) el.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}, 1000);

// ---------------------------------------------------------------- pairing (phone)

function pairingHtml() {
  const code = S.pairCode ? `${S.pairCode.slice(0, 3)} ${S.pairCode.slice(3)}` : '';
  if (isIOS && !isStandalone && !S.pairHere) {
    return `<div class="pair">
      <img src="/icons/apple-touch-icon.png" alt="">
      <h1>Agent Monitor</h1>
      <p>Add this app to your Home Screen first. Notifications only work from there.</p>
      <ol class="steps">
        <li>Tap the Share button ${ICON.share} at the bottom of Safari.</li>
        <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open <b>Agents</b> from your Home Screen and enter the code from your PC.</li>
      </ol>
      ${code ? `<p>Your pairing code</p><div class="code-big">${code}</div><p class="help">Valid for 15 minutes. You'll type it in the app.</p>` : ''}
      <button class="link-btn" data-act="pair-here">Use it in Safari instead</button>
    </div>`;
  }
  return `<div class="pair">
    <img src="/icons/apple-touch-icon.png" alt="">
    <h1>Pair with your PC</h1>
    <p>On the PC, click the Agent Monitor tray icon and choose <b>Pair a phone</b> to see the 6-digit code.</p>
    <form id="pair-form" autocomplete="off">
      <label for="pair-code">Pairing code</label>
      <input id="pair-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000" value="${esc(code)}" required>
      <label for="pair-name">Name for this phone</label>
      <input id="pair-name" maxlength="40" value="iPhone">
      <button class="btn primary block" type="submit">Pair</button>
      <p class="error" id="pair-error"></p>
    </form>
  </div>`;
}

async function submitPair(form) {
  const code = form.querySelector('#pair-code').value.replace(/\D/g, '');
  const name = form.querySelector('#pair-name').value.trim() || 'iPhone';
  const errorEl = form.querySelector('#pair-error');
  const button = form.querySelector('button[type=submit]');
  if (code.length !== 6) {
    errorEl.textContent = 'Enter the 6-digit code shown on the PC.';
    return;
  }
  button.classList.add('busy');
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Pairing failed.');
    S.token = data.token;
    storeSet(TOKEN_KEY, data.token);
    S.pairCode = '';
    await start();
    toast('Paired. Turn on notifications in Settings.');
  } catch (e) {
    errorEl.textContent = e.message === 'Failed to fetch' ? 'Can’t reach the PC. Is Tailscale on?' : e.message;
  } finally {
    button.classList.remove('busy');
  }
}

function unpaired(message) {
  if (stream) stream.abort();
  S.token = null;
  S.who = null;
  S.state = null;
  storeSet(TOKEN_KEY, null);
  storeSet(STATE_KEY, null);
  render();
  if (message) toast(message, 'error');
}

// ---------------------------------------------------------------- events

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  const d = el.dataset;
  switch (d.act) {
    case 'tab':
      S.tab = d.tab;
      closeSheet();
      if (S.tab === 'pc') loadPc();
      scrollTo(0, 0);
      render();
      break;
    case 'filter':
      S.filter = d.filter;
      renderMain();
      break;
    case 'refresh':
      retryDelay = 1000;
      connect();
      if (S.tab === 'pc') loadPc();
      break;
    case 'open':
      openSheet({ type: 'session', key: d.key });
      break;
    case 'close':
      closeSheet();
      break;
    case 'sa':
      sessionAction(d.key, d.action);
      break;
    case 'app':
      openSheet({ type: 'app', id: d.app });
      break;
    case 'aa':
      appAction(d.app, d.action);
      break;
    case 'confirm': {
      const run = S.sheet?.run;
      if (!run) return closeSheet();
      if (run.kind === 'session') sessionAction(run.key, run.action, { confirmed: true, force: !!run.force });
      else appAction(run.id, run.action, { confirmed: true, force: !!run.force });
      break;
    }
    case 'push-on':
      pushOn();
      break;
    case 'push-off':
      pushOff();
      break;
    case 'push-test':
    case 'push-test-all':
      api('/api/push/test', { method: 'POST' })
        .then((r) => toast(r.sent ? 'Test sent. It should arrive in a few seconds.' : 'The test could not be delivered.', r.sent ? 'ok' : 'error'))
        .catch((err) => toast(err.message, 'error'));
      break;
    case 'awake':
      saveSettings({ keepAwake: d.mode });
      break;
    case 'unpair':
      if (confirm('Unpair this phone? You will need a new code from the PC to pair again.')) {
        api('/api/device/unpair', { method: 'POST' }).finally(() => unpaired());
      }
      break;
    case 'pair-here':
      S.pairHere = true;
      renderMain();
      break;
    case 'pc-code':
      loadPc(true);
      break;
    case 'pc-serve':
      el.classList.add('busy');
      api('/api/admin/tailscale/serve', { method: 'POST' })
        .then((r) => toast(r.message, r.ok ? 'ok' : 'error'))
        .catch((err) => toast(err.message, 'error'))
        .finally(() => loadPc());
      break;
    case 'pc-remove':
      if (confirm('Remove this phone? It stops receiving updates and notifications.')) {
        api(`/api/admin/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' })
          .then(() => loadPc())
          .catch((err) => toast(err.message, 'error'));
      }
      break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset;
  if (d.act === 'pref') {
    api('/api/push/prefs', { method: 'PATCH', body: { prefs: { [d.pref]: el.checked } } })
      .then((device) => {
        S.who.device = device;
      })
      .catch((err) => toast(err.message, 'error'));
  } else if (d.act === 'auto') {
    saveSettings({ autoReconnect: el.checked });
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'pair-form') {
    e.preventDefault();
    submitPair(e.target);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'pair-code') return;
  const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
  e.target.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

function handleUrl(url) {
  const i = url.indexOf('#');
  if (i < 0) return;
  const hash = url.slice(i + 1);
  if (hash === 'pc') S.tab = 'pc';
  const params = new URLSearchParams(hash);
  if (params.get('pair')) S.pairCode = params.get('pair').replace(/\D/g, '').slice(0, 6);
  if (params.get('s')) {
    S.tab = 'sessions';
    openSheet({ type: 'session', key: params.get('s') });
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

addEventListener('hashchange', () => {
  handleUrl(location.href);
  render();
  if (S.tab === 'pc') loadPc();
});

// ---------------------------------------------------------------- start

async function start() {
  try {
    S.who = await api('/api/whoami');
  } catch (e) {
    if (e.status === 401) return unpaired(S.token ? 'This phone is no longer paired. Pair it again.' : undefined);
    // PC unreachable: show the last known state while retrying.
    if (!S.token) {
      S.conn = 'offline';
      $('#main').innerHTML = `<div class="pair"><h1>Can’t reach the PC</h1><p>Check that the PC is on and Tailscale is connected, then reload.</p></div>`;
      return;
    }
  }
  if (!S.state) {
    try {
      const cached = JSON.parse(storeGet(STATE_KEY) || 'null');
      if (cached?.sessions) {
        S.state = cached;
        S.lastOk = cached.agent?.now || 0;
      }
    } catch {
      /* ignore a broken cache */
    }
  }
  render();
  connect();
  if (S.tab === 'pc') loadPc();
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) {
      handleUrl(new URL(e.data.url, location.origin).href);
      render();
    }
  });
}

handleUrl(location.href);
start();
