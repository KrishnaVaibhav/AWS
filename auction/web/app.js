// Auction web console: no framework, no build step. Talks to /api/* and
// listens on AppSync Events for live item updates, chat and personal alerts.
// Every string from the server goes into the DOM as text, never as HTML.

import { el, merge } from './dom.js';
import { rulesForm, FORMATS, VISIBILITY } from './rules-form.js';

const cfg = await fetch('/config.json').then((r) => r.json());
const $ = (id) => document.getElementById(id);
document.getElementById('stage').textContent = cfg.stage;

// Wide tables scroll sideways on phones instead of squashing the page.
const tableOf = (...rows) => el('div', { class: 'scroll' }, el('table', {}, ...rows));
const buzz = (pattern) => navigator.vibrate?.(pattern);
const urgent = (ms) => !!ms && ms - Date.now() - clockSkew < 60_000;

function toast(text, bad = false) {
  const t = el('div', { class: `toast${bad ? ' bad' : ''}` }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

const money = (n, cur) => (n == null ? '—' : `${n.toLocaleString()} ${cur ?? ''}`.trim());
const when = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
function left(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((ms - Date.now() - clockSkew) / 1000));
  if (s === 0) return 'closing…';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// ── Sign-in (Cognito hosted UI, code flow + PKCE) ─────────────────────

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = `${location.origin}/auth/callback`;
let session = JSON.parse(sessionStorage.getItem('session') ?? 'null');

function claims(token) {
  return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
}

async function tokenRequest(params) {
  const res = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.userPoolClientId, ...params }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  const t = await res.json();
  session = { id: t.id_token, refresh: t.refresh_token ?? session?.refresh, exp: claims(t.id_token).exp * 1000 };
  sessionStorage.setItem('session', JSON.stringify(session));
}

async function login() {
  if (cfg.devLogin) return location.assign('/dev/login'); // npm run dev: local test sign-in
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('pkce', JSON.stringify({ verifier, state, back: location.hash }));
  location.assign(`https://${cfg.cognitoDomain}/oauth2/authorize?${new URLSearchParams({
    response_type: 'code', client_id: cfg.userPoolClientId, redirect_uri: redirectUri,
    scope: 'openid email profile', code_challenge_method: 'S256', code_challenge: challenge, state,
  })}`);
}

function logout() {
  sessionStorage.removeItem('session');
  if (cfg.devLogin) return location.assign('/');
  location.assign(`https://${cfg.cognitoDomain}/logout?${new URLSearchParams({ client_id: cfg.userPoolClientId, logout_uri: `${location.origin}/` })}`);
}

async function idToken() {
  if (!session) return null;
  if (Date.now() > session.exp - 60_000) {
    try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh }); } catch { session = null; sessionStorage.removeItem('session'); return null; }
  }
  return session.id;
}

if (location.pathname === '/auth/callback') {
  const q = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem('pkce') ?? '{}');
  sessionStorage.removeItem('pkce');
  if (q.get('code') && q.get('state') === saved.state) {
    await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri, code_verifier: saved.verifier })
      .catch((e) => toast(e.message, true));
  }
  history.replaceState(null, '', `/${saved.back || '#/'}`);
}

const me = session ? claims(session.id) : null;
$('login').hidden = !!me;
$('logout').hidden = !me;
$('who').textContent = me ? me.email : '';
$('login').onclick = login;
$('logout').onclick = logout;

// ── API ───────────────────────────────────────────────────────────────

let clockSkew = 0;

async function api(method, path, body) {
  const headers = {};
  const token = await idToken();
  if (token) headers['x-auth-token'] = token;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    // CloudFront signs requests to the Lambda origin and needs the body hash.
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    headers['x-amz-content-sha256'] = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.headers.get('content-type')?.includes('text/csv')) return res.blob();
  const data = await res.json();
  if (data.serverTime) clockSkew = Date.now() - data.serverTime;
  if (res.status === 401 && token) {
    // The session expired or was revoked: drop it so the page offers Sign in again.
    sessionStorage.removeItem('session');
    session = null;
    $('login').hidden = false;
    $('logout').hidden = true;
    $('who').textContent = '';
    throw Object.assign(new Error('Your session ended. Please sign in again.'), data);
  }
  if (!res.ok) throw Object.assign(new Error(data.message ?? res.statusText), data);
  return data;
}

// Every setting with its default, from the server, for the settings forms.
let defaultsCache = null;
const ruleDefaults = async () => (defaultsCache ??= (await api('GET', '/api/rules/defaults')).rules);

/** Like attempt, but a rejected setting is highlighted in the form instead of only toasted. */
async function saveWith(form, fn, okText) {
  try {
    const out = await fn();
    if (okText) toast(okText);
    return out;
  } catch (err) {
    toast(err.path && form?.flag(err.path, err.message) ? 'Check the highlighted setting' : err.message, true);
    return null;
  }
}

function downloadText(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

const inDays = (days) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
};

async function attempt(fn, okText) {
  try {
    const out = await fn();
    if (okText) toast(okText);
    return out;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

// ── Live updates (AppSync Events WebSocket) ───────────────────────────

const live = {
  ws: null, ready: false, subs: new Map(), retry: 0,
  auth(kind) {
    return kind === 'user'
      ? { Authorization: session?.id, host: cfg.eventsHttp }
      : { 'x-api-key': cfg.eventsApiKey, host: cfg.eventsHttp };
  },
  connect() {
    const header = btoa(JSON.stringify(this.auth('public'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    this.ws = new WebSocket(`wss://${cfg.eventsRealtime}/event/realtime`, ['aws-appsync-event-ws', `header-${header}`]);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'connection_init' }));
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'connection_ack') {
        this.ready = true; this.retry = 0;
        for (const [id, s] of this.subs) this.send(id, s);
      } else if (msg.type === 'data') {
        const sub = this.subs.get(msg.id);
        const events = Array.isArray(msg.event) ? msg.event : [msg.event];
        for (const e of events) sub?.cb(typeof e === 'string' ? JSON.parse(e) : e);
      } else if (msg.type === 'subscribe_error') console.warn('subscribe failed', msg);
    };
    this.ws.onclose = () => {
      this.ready = false;
      setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.retry++) * (0.5 + Math.random()));
    };
  },
  send(id, s) {
    this.ws.send(JSON.stringify({ type: 'subscribe', id, channel: s.channel, authorization: this.auth(s.kind) }));
  },
  subscribe(channel, kind, cb) {
    const id = crypto.randomUUID();
    this.subs.set(id, { channel, kind, cb });
    if (this.ready) this.send(id, this.subs.get(id));
    return () => { this.subs.delete(id); if (this.ready) this.ws.send(JSON.stringify({ type: 'unsubscribe', id })); };
  },
};
if (cfg.eventsRealtime) live.connect(); // off in npm run dev

const userHandlers = new Set();
if (me) {
  live.subscribe(`/user/${me.sub}`, 'user', (e) => {
    const text = {
      outbid: 'You were outbid.', won: `You won an item for ${e.price}!`, bid_decided: `Your bid was ${e.status}.`,
      bid_cancelled: 'The host cancelled one of your bids.',
      registration: `Your registration is now ${e.status}.`, bid_pending: 'A bid is waiting for your approval.',
      registration_pending: 'Someone asked to join your auction.', offer_pending: 'You have a new offer.',
      offer_countered: `The seller countered with ${e.amount}.`, offer_decided: `Your offer was ${e.status}.`,
      item_closed: `An item closed: ${String(e.outcome).replace(/_/g, ' ')}.`,
    }[e.type];
    if (text) toast(text, e.type === 'outbid');
    if (e.type === 'outbid') buzz([80, 60, 80]);
    else if (e.type === 'won') buzz([200, 100, 200, 100, 400]);
    for (const h of userHandlers) h(e);
  });
}

async function download(path, name) {
  const blob = await attempt(() => api('GET', path));
  if (!blob) return;
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

function mediaView(key) {
  const src = `/${key}`;
  if (/\.(mp4|mov)$/i.test(key)) return el('video', { src, controls: true, playsinline: true, preload: 'metadata' });
  if (/\.pdf$/i.test(key)) return el('a', { href: src, target: '_blank', rel: 'noopener' }, '📄 Document (PDF)');
  if (/\.glb$/i.test(key)) return el('a', { href: src, download: '' }, '🧊 3D model (.glb)');
  return el('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
}

// ── Router ────────────────────────────────────────────────────────────

let teardown = [];
let refresh = () => route(); // pages that can update in place replace this
async function route() {
  teardown.forEach((f) => f());
  teardown = [];
  refresh = () => route();
  const [, page, id] = location.hash.split('/');
  const view = $('view');
  view.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try {
    let node;
    if (page === 'a' && id) node = await auctionPage(id);
    else if (page === 'me') node = await mePage();
    else node = await homePage();
    view.replaceChildren(node);
  } catch (err) {
    view.replaceChildren(el('div', { class: 'card bad' }, err.message));
  }
}
window.addEventListener('hashchange', route);

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 5000 && !document.querySelector('input:focus, textarea:focus')) refresh();
});
const offline = el('div', { class: 'offline', hidden: navigator.onLine }, 'Offline: prices and chat are paused until you reconnect.');
document.body.append(offline);
window.addEventListener('offline', () => { offline.hidden = false; });
window.addEventListener('online', () => { offline.hidden = true; refresh(); });

// ── Home ──────────────────────────────────────────────────────────────

// Friendlier starting values than the bare defaults for a new auction.
const STARTER = { price: { start: 10 }, increment: { mode: 'fixed', fixed: 5 } };
async function homePage() {
  const card = (a) => el('a', { href: `#/a/${a.id}`, class: 'card', style: 'display:block;text-decoration:none;color:inherit' },
    el('h3', {}, a.title), el('div', { class: 'muted' }, `${a.host} · ${a.itemCount} items · `, el('span', { class: 'tag' }, a.status)));
  const section = async (title, scope) => {
    const { auctions } = await api('GET', `/api/auctions?scope=${scope}`);
    return el('section', {}, el('h2', {}, title), auctions.length ? el('div', { class: 'grid' }, auctions.map(card)) : el('p', { class: 'muted' }, 'Nothing here yet.'));
  };
  const parts = [await section('Live auctions', 'live')];
  if (!me) {
    parts.push(el('p', { class: 'muted' }, 'Sign in to host or bid.'));
    return el('div', {}, parts);
  }
  parts.push(await section('Your auctions', 'mine'), await section('Joined', 'joined'));
  const [{ templates }, defaults] = await Promise.all([api('GET', '/api/templates'), ruleDefaults()]);
  const title = el('input', { placeholder: 'e.g. Spring estate sale', maxlength: 120 });
  const description = el('textarea', { rows: 2, class: 'plain', maxlength: 5000, placeholder: 'What is on offer, pickup or shipping… (optional)' });
  const template = el('select', {}, el('option', { value: '' }, 'Start from scratch'), templates.map((t) => el('option', { value: t.id }, t.name)));
  const formBox = el('div');
  let form;
  const startForm = () => {
    const t = templates.find((x) => x.id === template.value);
    const rules = merge(merge(defaults, STARTER), t?.rules ?? {});
    const past = (iso) => !iso || Date.parse(iso) < Date.now();
    if (past(rules.timing.closesAt)) rules.timing.closesAt = inDays(7);
    if (rules.timing.opensAt && past(rules.timing.opensAt)) rules.timing.opensAt = null;
    form = rulesForm(rules);
    formBox.replaceChildren(form.node);
  };
  template.onchange = startForm;
  startForm();
  parts.push(el('section', { class: 'card stack host' },
    el('h2', {}, 'Host an auction'),
    el('p', { class: 'muted' }, 'Pick a type and a closing time. Everything else has sensible defaults, and you can change it later in Settings.'),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Title'), title),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Description'), description),
    templates.length ? el('label', { class: 'field' }, el('span', { class: 'label' }, 'Start from one of your templates'), template) : null,
    formBox,
    el('button', { class: 'main', onclick: async () => {
      if (!title.value.trim()) { title.focus(); return toast('Give the auction a title', true); }
      const body = { title: title.value.trim(), rules: form.value() };
      if (description.value.trim()) body.description = description.value.trim();
      const out = await saveWith(form, () => api('POST', '/api/auctions', body));
      if (out) location.hash = `#/a/${out.auction.id}`;
    } }, 'Create draft')));
  if (templates.length) {
    parts.push(el('section', { class: 'card stack' }, el('h2', {}, 'Your templates'),
      templates.map((t) => el('div', { class: 'row' }, el('strong', {}, t.name), el('span', { class: 'muted' }, FORMATS[t.rules.format]?.[0] ?? t.rules.format),
        el('button', { class: 'ghost', onclick: async () => { if (await attempt(() => api('DELETE', `/api/templates/${t.id}`), 'Template deleted')) route(); } }, 'Delete')))));
  }
  return el('div', {}, parts);
}

// ── My stuff ──────────────────────────────────────────────────────────

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('This browser has no Web Push', true);
  if (await Notification.requestPermission() !== 'granted') return toast('Notifications were not allowed', true);
  const reg = await navigator.serviceWorker.register('/sw.js');
  const { publicKey } = await api('GET', '/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await attempt(() => api('POST', '/api/me/push', { subscription: sub.toJSON() }), 'Push notifications on for this browser');
}

async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return toast('Push was not on in this browser');
  await attempt(() => api('DELETE', `/api/me/push?endpoint=${encodeURIComponent(sub.endpoint)}`), 'Push notifications off');
  await sub.unsubscribe();
}

async function mePage() {
  if (!me) return el('p', { class: 'muted' }, 'Sign in first.');
  const [bids, watch, notes] = await Promise.all([api('GET', '/api/me/bids'), api('GET', '/api/me/watchlist'), api('GET', '/api/me/notifications')]);
  const row = ({ auction, item }) => {
    const s = item.state;
    let status = s.status;
    if (s.result) status = s.result.winner?.you ? `won · ${money(s.result.price, item.currency)}` : s.result.outcome.replace(/_/g, ' ');
    else if (s.you?.leading) status = 'winning';
    else if (s.you?.sealedBid != null) status = `sealed bid ${s.you.sealedBid}`;
    return el('tr', {}, el('td', {}, el('a', { href: `#/a/${auction.id}` }, auction.title)), el('td', {}, item.title),
      el('td', {}, s.price == null ? '—' : money(s.price, item.currency)), el('td', {}, status), el('td', { 'data-closes': s.closesAt ?? '', class: s.status === 'open' && urgent(s.closesAt) ? 'urgent' : null }, s.status === 'open' ? left(s.closesAt) : ''));
  };
  const list = (items) => (items.length
    ? tableOf(el('tr', {}, ['Auction', 'Item', 'Price', 'Status', 'Time left'].map((h) => el('th', {}, h))), items.map(row))
    : el('p', { class: 'muted' }, 'Nothing yet.'));
  const page = el('div', {},
    el('section', { class: 'card stack' }, el('h2', {}, 'My bids'), list(bids.items)),
    el('section', { class: 'card stack' }, el('h2', {}, 'Watchlist'), list(watch.items)),
    el('section', { class: 'card stack' },
      el('div', { class: 'row' }, el('h2', {}, 'Notifications'), el('span', { class: 'spacer' }),
        el('button', { class: 'ghost', onclick: enablePush }, 'Enable push'), el('button', { class: 'ghost', onclick: disablePush }, 'Disable push')),
      notes.notifications.length
        ? tableOf(notes.notifications.map((n) => el('tr', {}, el('td', {}, when(n.at)), el('td', { class: 'wrap' }, el('a', { href: n.url }, n.text)))))
        : el('p', { class: 'muted' }, 'No notifications.')));
  const ticker = setInterval(() => page.querySelectorAll('td[data-closes]').forEach((n) => {
    if (!n.dataset.closes) return;
    n.textContent = left(Number(n.dataset.closes));
    n.classList.toggle('urgent', urgent(Number(n.dataset.closes)));
  }), 1000);
  teardown.push(() => clearInterval(ticker));
  return page;
}

// ── Auction page ──────────────────────────────────────────────────────

async function auctionPage(aid) {
  const root = el('div');
  let auction;
  let items = [];
  const itemsBox = el('div');
  const ownerBox = el('div');
  const head = el('div', { class: 'card' });

  // Registered bidders, fetched once per load for the owner's "bid for" picker.
  let biddersPromise = null;
  const bidders = () => (biddersPromise ??= api('GET', `/api/auctions/${aid}/registrations`).then((d) => d.registrations).catch(() => []));

  async function load() {
    biddersPromise = null;
    ({ auction } = await api('GET', `/api/auctions/${aid}`));
    if (auction.locked) return;
    ({ items } = await api('GET', `/api/auctions/${aid}/items`));
    renderHead();
    renderItems();
    if (auction.you.owner) renderOwner();
  }

  function lockedView() {
    const code = el('input', { placeholder: 'Access code' });
    const alias = el('input', { placeholder: 'Alias (optional)' });
    return el('div', { class: 'card stack' }, el('h1', {}, auction.title), el('div', { class: 'muted' }, `Hosted by ${auction.host}`),
      el('p', {}, 'This auction is private. Join with its access code, or sign in with an invited email.'),
      me ? el('div', { class: 'row' }, code, alias, el('button', {
        onclick: async () => {
          if (await attempt(() => api('POST', `/api/auctions/${aid}/register`, { code: code.value || undefined, alias: alias.value || undefined }), 'Joined')) route();
        },
      }, 'Join')) : el('button', { onclick: login }, 'Sign in to join'));
  }

  function renderHead() {
    const you = auction.you;
    const reg = you.registration;
    const bits = [el('h1', {}, auction.title), el('div', { class: 'muted' }, `Hosted by ${auction.host} · `, el('span', { class: 'tag' }, auction.status),
      auction.rules.access?.mode && auction.rules.access.mode !== 'public' ? el('span', { class: 'tag warn' }, ` ${auction.rules.access.mode}`) : null)];
    if (auction.description) bits.push(el('p', {}, auction.description));
    const status = el('div', { class: 'row' });
    if (you.owner) status.append(el('span', { class: 'tag warn' }, 'You own this auction'));
    else if (reg) status.append(el('span', { class: `tag ${reg.status === 'approved' ? 'ok' : 'warn'}` }, `Registered as ${reg.alias} (paddle ${reg.paddle}) · ${reg.status}`));
    else if (me && auction.status === 'live') {
      const alias = el('input', { placeholder: 'Alias (optional)' });
      status.append(alias, el('button', { onclick: async () => { if (await attempt(() => api('POST', `/api/auctions/${aid}/register`, { alias: alias.value || undefined }), 'Registered')) load(); } }, 'Register to bid'));
    }
    if (auction.balance) {
      const b = auction.balance;
      status.append(el('span', { class: 'tag' }, `Balance ${b.balance} ${auction.rules.balance.unit} · available ${b.available} · held ${b.committed}`));
    }
    if (me && !you.owner) status.append(el('button', { class: 'ghost', onclick: invoicesDialog }, 'My invoices'));
    bits.push(status);
    head.replaceChildren(...bits);
  }

  async function invoicesDialog() {
    const { invoices } = await api('GET', `/api/auctions/${aid}/invoices`);
    const box = el('div', { class: 'card stack' }, el('h2', {}, 'Invoices'));
    if (!invoices.length) box.append(el('p', { class: 'muted' }, 'Nothing won yet.'));
    for (const inv of invoices) box.append(invoiceTable(inv, false));
    itemsBox.prepend(box);
  }

  function invoiceTable(inv, owner) {
    return el('div', { class: 'stack' },
      el('div', { class: 'row' }, el('strong', {}, inv.buyer.label), inv.buyer.paddle != null ? el('span', { class: 'muted' }, `paddle ${inv.buyer.paddle}`) : null,
        el('span', { class: 'tag' }, `total ${inv.total}`), inv.unpaid ? el('span', { class: 'tag bad' }, `unpaid ${inv.unpaid}`) : el('span', { class: 'tag ok' }, 'paid')),
      inv.instructions && !owner ? el('p', { class: 'muted' }, inv.instructions) : null,
      tableOf(el('tr', {}, ['Item', 'Price', 'How', 'Due', 'Payment', 'Delivery'].map((h) => el('th', {}, h))),
        inv.lines.map((l) => {
          const pay = el('select', {}, ['unpaid', 'paid', 'waived', 'refunded'].map((v) => el('option', { value: v }, v)));
          const ship = el('select', {}, ['pending', 'shipped', 'picked_up', 'delivered'].map((v) => el('option', { value: v }, v.replace('_', ' '))));
          pay.value = l.payment.status;
          ship.value = l.fulfillment.status;
          const save = () => attempt(() => api('PATCH', `/api/auctions/${aid}/items/${l.itemId}/result`, { payment: { status: pay.value }, fulfillment: { status: ship.value } }), 'Saved');
          pay.onchange = save;
          ship.onchange = save;
          return el('tr', {}, el('td', {}, l.title), el('td', {}, money(l.price, l.currency)), el('td', {}, l.via.replace('_', ' ')), el('td', {}, when(l.dueAt)),
            el('td', {}, owner ? pay : l.payment.status), el('td', {}, owner ? ship : l.fulfillment.status.replace('_', ' ')));
        })));
  }

  function renderItems() {
    itemsBox.replaceChildren(...items.map(itemCard));
  }

  function itemCard(item) {
    const s = item.state;
    const box = el('div', { class: 'card stack' });
    const cur = item.currency;
    box.append(el('div', { class: 'row' }, el('h2', {}, item.lot ? `#${item.lot} ` : '', item.title), el('span', { class: 'tag' }, s.status),
      el('span', { class: 'tag' }, item.format.replace('_', ' ')), el('span', { class: 'spacer' }),
      me && s.status !== 'draft' ? el('button', { class: 'ghost', onclick: async () => {
        if (await attempt(() => api(item.watching ? 'DELETE' : 'POST', `/api/auctions/${aid}/items/${item.id}/watch`), item.watching ? 'Removed from watchlist' : 'Watching')) load();
      } }, item.watching ? '★ Watching' : '☆ Watch') : null));
    if (item.description) box.append(el('div', {}, item.description));
    if (Object.keys(item.fields).length) box.append(el('div', { class: 'muted' }, Object.entries(item.fields).map(([k, v]) => `${k}: ${v}`).join(' · ')));
    if (item.media.length) box.append(el('div', { class: 'media' }, item.media.map(mediaView)));
    if (auction.you.owner) box.append(ownerItemTools(item));
    if (s.status !== 'draft') {
      const facts = el('div', { class: 'row' });
      const sealedOpen = item.format.startsWith('sealed') && s.status === 'open';
      const opening = !s.bidCount && s.nextMin != null && ['english', 'reverse'].includes(item.format) && s.status === 'open';
      facts.append(el('span', { class: 'price' }, sealedOpen ? 'Sealed bids' : opening ? `Opens at ${money(s.nextMin, cur)}` : s.price == null ? 'Price hidden' : money(s.price, cur)));
      if (s.dutch?.nextDropAt) facts.append(el('span', { class: 'muted', 'data-closes': s.dutch.nextDropAt }, `next drop ${left(s.dutch.nextDropAt)}`));
      if (s.bidCount != null && item.format !== 'fixed_price') facts.append(el('span', { class: 'muted' }, `${s.bidCount} ${sealedOpen ? 'bidder' : 'bid'}${s.bidCount === 1 ? '' : 's'}`));
      if (s.closesAt) facts.append(el('span', { class: urgent(s.closesAt) ? 'urgent' : 'muted', 'data-closes': s.closesAt }, `⏱ ${left(s.closesAt)}`));
      if (s.extensions) facts.append(el('span', { class: 'tag warn' }, `extended ×${s.extensions}`));
      if (s.reserve.exists && !sealedOpen) facts.append(el('span', { class: `tag ${s.reserve.met ? 'ok' : 'bad'}` }, s.reserve.met == null ? 'reserve' : s.reserve.met ? 'reserve met' : 'reserve not met', s.reserve.amount != null ? ` (${s.reserve.amount})` : ''));
      if (s.leader) facts.append(el('span', { class: 'muted' }, `Leader: ${s.leader.label}`));
      if (s.you?.leading) facts.append(el('span', { class: 'tag ok' }, s.you.max ? `You lead · your max ${s.you.max}` : 'You lead'));
      if (s.you?.sealedBid != null) facts.append(el('span', { class: 'tag ok' }, `Your sealed bid: ${s.you.sealedBid}`));
      if (auction.you.owner && s.pendingCount) facts.append(el('span', { class: 'tag warn' }, `${s.pendingCount} waiting for approval`));
      box.append(facts);
      if (s.result) {
        box.append(el('div', { class: 'tag ok' }, `Result: ${s.result.outcome.replace(/_/g, ' ')}`, s.result.price != null ? ` at ${money(s.result.price, cur)}` : '',
          s.result.via && s.result.via !== 'auction' ? ` (${s.result.via.replace('_', ' ')})` : '', s.result.winner ? ` · ${s.result.winner.label}` : ''));
        if (s.result.instructions) box.append(el('p', { class: 'muted' }, `Payment: ${s.result.instructions}`));
      }
      if (s.status === 'open' && me) box.append(bidForm(item));
      if (item.offers && me) box.append(offersView(item));
      if (item.format !== 'fixed_price' && item.format !== 'dutch') box.append(itemExtras(item));
    }
    return box;
  }

  function buyButton(item, label) {
    return el('button', { onclick: async () => {
      if (!window.confirm(`${label}?`)) return;
      if (await attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/buy`), 'Bought!')) load();
    } }, label);
  }

  function bidForm(item) {
    const s = item.state;
    const owner = auction.you.owner;
    if (owner && !auction.rules.conduct.hostCanBid && !['english', 'reverse', 'sealed_first', 'sealed_second'].includes(item.format)) return el('span');
    if (item.format === 'fixed_price') return owner ? el('span') : el('div', { class: 'row' }, buyButton(item, `Buy now for ${money(s.price, item.currency)}`));
    if (item.format === 'dutch') {
      return owner ? el('span') : el('div', { class: 'row' }, el('button', { onclick: async () => {
        if (!window.confirm(`Buy now at ${s.price}? The price only goes down, but someone else may buy first.`)) return;
        if (await attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/bids`, { amount: s.price }), 'Bought!')) load();
      } }, `Buy at ${money(s.price, item.currency)}`), el('span', { class: 'muted' }, `floor ${s.dutch?.floor ?? '—'}`));
    }
    const amount = el('input', { type: 'number', class: 'amount', min: 1, step: 1, inputmode: 'numeric', enterkeyhint: 'send', 'aria-label': 'Bid amount', value: s.nextMin ?? '' });
    const max = item.proxy ? el('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', placeholder: 'max (optional)', 'aria-label': 'Maximum bid' }) : null;
    // Steppers move by the current increment so thumbs never need the keyboard.
    const gap = s.price != null && s.nextMin != null ? Math.abs(s.nextMin - s.price) : 0;
    const stepBy = gap > 0 ? gap : 1;
    const nudge = (sign) => { amount.value = Math.max(1, (Number(amount.value) || s.nextMin || 0) + sign * stepBy); };
    const steppers = [el('button', { class: 'ghost step', 'aria-label': 'Lower', onclick: () => nudge(-1) }, '−'), el('button', { class: 'ghost step', 'aria-label': 'Raise', onclick: () => nudge(1) }, '+')];
    const onBehalf = owner ? el('select', { 'aria-label': 'Bid for' }, el('option', { value: '' }, auction.rules.conduct.hostCanBid ? 'Bid as myself' : 'Bid for… (choose a bidder)')) : null;
    if (onBehalf) {
      bidders().then((regs) => onBehalf.append(...regs.filter((r) => r.status === 'approved').map((r) => el('option', { value: r.uid }, `${r.alias} (#${r.paddle})`))));
    }
    const presets = item.increment.mode === 'bidder_choice' && s.price != null && item.format === 'english'
      ? item.increment.presets.map((p) => el('button', { class: 'ghost', onclick: () => { amount.value = s.price + p; } }, `+${p}`)) : [];
    const send = async (confirmed = false, value = Number(amount.value)) => {
      if (!value) return toast('Enter an amount', true);
      if (owner && !auction.rules.conduct.hostCanBid && !onBehalf.value) return toast('Choose the bidder this bid is for', true);
      const body = { amount: value, confirmed };
      if (max?.value) body.max = Number(max.value);
      if (onBehalf?.value) body.onBehalfOf = onBehalf.value.trim();
      try {
        const out = await api('POST', `/api/auctions/${aid}/items/${item.id}/bids`, body);
        toast(out.status === 'pending' ? 'Bid sent; waiting for the host to approve it'
          : out.outcome === 'outbid' ? 'Bid placed, but another maximum is higher'
            : out.outcome === 'replaced' ? 'Your sealed bid was replaced' : 'Bid placed', out.outcome === 'outbid');
        buzz(out.outcome === 'outbid' ? [80, 60, 80] : 30);
        load();
      } catch (err) {
        if (err.error === 'confirm_required' && window.confirm(err.message.replace(/ Send.*/, ' Place it anyway?'))) return send(true, value);
        toast(err.message, true);
      }
    };
    const hint = [];
    if (s.nextMin != null) hint.push(s.direction === 'down' ? `at most ${s.nextMin}` : `min ${s.nextMin}`);
    if (s.maxBid != null) hint.push(`max ${s.maxBid}`);
    if (item.format.startsWith('sealed')) hint.push('one hidden bid; a new one replaces it');
    if (item.approval) hint.push(item.approval.mode === 'all' ? 'every bid needs approval' : `bids ≥ ${item.approval.threshold} need approval`);
    if (owner && !auction.rules.conduct.hostCanBid && !onBehalf) return el('span');
    amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    // One-thumb bid at the next minimum: first tap arms it, second tap within 3 s sends.
    let quick = null;
    if (!owner && s.nextMin != null && ['english', 'reverse'].includes(item.format)) {
      let armed = null;
      quick = el('button', { class: 'quick', onclick: () => {
        if (!armed) {
          quick.classList.add('armed');
          quick.textContent = `Tap again to bid ${money(s.nextMin, item.currency)}`;
          armed = setTimeout(() => { armed = null; quick.classList.remove('armed'); quick.textContent = `Bid ${money(s.nextMin, item.currency)}`; }, 3000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        quick.disabled = true;
        send(false, s.nextMin).finally(() => { quick.disabled = false; });
      } }, `Bid ${money(s.nextMin, item.currency)}`);
    }
    return el('div', { class: 'bid' }, quick, el('div', { class: 'stepper' }, steppers[0], amount, steppers[1]), max, presets, onBehalf,
      el('button', { class: quick ? 'ghost main' : 'main', onclick: () => send() }, owner ? 'Enter bid' : item.format.startsWith('sealed') ? 'Place sealed bid' : quick ? 'Bid this amount' : 'Bid'),
      s.buyNow != null && !owner ? buyButton(item, `Buy now for ${money(s.buyNow, item.currency)}`) : null,
      el('span', { class: 'muted' }, hint.join(' · ')));
  }

  function offersView(item) {
    const box = el('details', {}, el('summary', {}, auction.you.owner ? 'Offers' : 'Make an offer'));
    const body = el('div', { class: 'stack' });
    box.append(body);
    box.addEventListener('toggle', async () => {
      if (!box.open) return;
      const { offers } = await api('GET', `/api/auctions/${aid}/items/${item.id}/offers`);
      const rows = offers.map((o) => {
        const actions = [];
        if (auction.you.owner && o.status === 'pending') {
          const counter = el('input', { type: 'number', placeholder: 'counter', style: 'width:90px' });
          const act = (action, extra = {}) => attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/offers/${o.id}/decision`, { action, ...extra }), `Offer ${action}ed`).then((r) => r && load());
          actions.push(el('button', { onclick: () => act('accept') }, 'Accept'), el('button', { class: 'danger', onclick: () => act('decline') }, 'Decline'),
            counter, el('button', { class: 'ghost', onclick: () => act('counter', { amount: Number(counter.value) }) }, 'Counter'));
        }
        if (!auction.you.owner && o.status === 'countered') {
          const respond = (accept) => attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/offers/${o.id}/respond`, { accept }), accept ? 'Bought!' : 'Declined').then((r) => r && load());
          actions.push(el('button', { onclick: () => respond(true) }, `Accept ${o.counterAmount}`), el('button', { class: 'ghost', onclick: () => respond(false) }, 'Decline'));
        }
        if (!auction.you.owner && ['pending', 'countered'].includes(o.status)) {
          actions.push(el('button', { class: 'ghost', onclick: () => attempt(() => api('DELETE', `/api/auctions/${aid}/items/${item.id}/offers/${o.id}`), 'Withdrawn').then((r) => r && load()) }, 'Withdraw'));
        }
        return el('tr', {}, el('td', {}, o.buyer.label), el('td', {}, o.amount), el('td', {}, el('span', { class: 'tag' }, o.status), o.counterAmount ? ` → ${o.counterAmount}` : '', o.auto ? ' (auto)' : ''),
          el('td', { class: 'muted wrap' }, o.message ?? '', o.reply ? ` / ${o.reply}` : ''), el('td', {}, actions));
      });
      const parts = [rows.length ? tableOf(rows) : el('p', { class: 'muted' }, 'No offers yet.')];
      if (!auction.you.owner && item.state.status === 'open') {
        const amount = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'your offer' });
        const message = el('input', { placeholder: 'message (optional)', maxlength: 300 });
        parts.push(el('div', { class: 'row' }, amount, message, el('button', { onclick: async () => {
          const out = await attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/offers`, { amount: Number(amount.value), message: message.value || undefined }));
          if (out) { toast(out.offer.status === 'accepted' ? 'Accepted: it is yours!' : out.offer.status === 'declined' ? 'That offer was declined' : 'Offer sent'); load(); }
        } }, 'Send offer')));
      }
      body.replaceChildren(...parts);
    });
    return box;
  }

  function ownerItemTools(item) {
    const file = el('input', { type: 'file', accept: 'image/*,video/mp4,video/quicktime,application/pdf,.glb' });
    const upload = async () => {
      const f = file.files[0];
      if (!f) return toast('Choose a file first', true);
      const type = f.type || (f.name.endsWith('.glb') ? 'model/gltf-binary' : '');
      const out = await attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/uploads`, { contentType: type, size: f.size }));
      if (!out) return;
      const form = new FormData();
      for (const [k, v] of Object.entries(out.upload.fields)) form.append(k, v);
      form.append('file', f);
      const res = await fetch(out.upload.url, { method: 'POST', body: form });
      if (!res.ok) return toast(`Upload failed (${res.status})`, true);
      toast('Uploaded; it appears once it passes the file check');
      setTimeout(() => load(), 4000);
    };
    const removeMedia = (key) => attempt(() => api('PATCH', `/api/auctions/${aid}/items/${item.id}`, { media: item.media.filter((m) => m !== key) }), 'Removed').then((r) => r && load());
    const edit = el('details', { ontoggle: () => { if (edit.open && !edit.dataset.built) { edit.dataset.built = '1'; edit.append(itemForm(item)); } } },
      el('summary', {}, '✏️ Edit item'));
    return el('details', {}, el('summary', {}, 'Manage this item'),
      el('div', { class: 'stack' },
        edit,
        el('div', { class: 'field' }, el('span', { class: 'label' }, 'Add a photo, video, PDF or 3D model (.glb)'),
          el('div', { class: 'row' }, file, el('button', { class: 'ghost', onclick: upload }, 'Upload'))),
        item.media.length ? el('div', { class: 'row' }, item.media.map((m) => el('button', { class: 'ghost', title: 'Remove this file', onclick: () => removeMedia(m) }, `✕ Remove ${m.split('/').pop()}`))) : null,
        el('div', { class: 'row' }, el('button', { class: 'danger', onclick: async () => {
          if (!window.confirm(`Delete "${item.title}"? Only items without bids or offers can be deleted.`)) return;
          if (await attempt(() => api('DELETE', `/api/auctions/${aid}/items/${item.id}`), 'Item deleted')) load();
        } }, 'Delete item'))));
  }

  function itemExtras(item) {
    const out = el('div');
    const tabs = el('div', { class: 'tabs' });
    const body = el('div');
    const show = async (name) => {
      [...tabs.children].forEach((b) => b.classList.toggle('on', b.textContent === name));
      body.replaceChildren(el('span', { class: 'muted' }, 'Loading…'));
      body.replaceChildren(name === 'Board' ? await boardView(item) : await bidsView(item));
    };
    for (const name of ['Board', 'Bids']) tabs.append(el('button', { onclick: () => show(name) }, name));
    out.append(el('details', { ontoggle: (e) => { if (e.target.open && !body.childElementCount) show('Board'); } }, el('summary', {}, 'Standings and bids'), tabs, body));
    return out;
  }

  async function boardView(item) {
    const { board } = await api('GET', `/api/auctions/${aid}/items/${item.id}/board`);
    if (!board) return el('p', { class: 'muted' }, item.format.startsWith('sealed') ? 'Sealed: standings appear after the close.' : 'The host keeps the standings private.');
    const names = { rank: '#', bidder: 'Bidder', amount: 'Amount', time: 'Time', status: 'Status', bids: 'Bids' };
    return tableOf(el('tr', {}, board.columns.map((c) => el('th', {}, names[c]))),
      board.rows.map((r) => el('tr', { style: r.you ? 'color:var(--accent)' : '' }, board.columns.map((c) => el('td', {},
        c === 'bidder' ? r.bidder?.label : c === 'time' ? when(r.time) : c === 'amount' ? (r.amount ?? 'hidden') : (r[c] ?? '—'))))));
  }

  async function bidsView(item) {
    const { bids, historyVisible } = await api('GET', `/api/auctions/${aid}/items/${item.id}/bids`);
    const owner = auction.you.owner;
    const rows = bids.map((b) => el('tr', {},
      el('td', {}, when(b.placedAt)),
      el('td', {}, b.bidder.label, owner && b.bidder.paddle != null ? ` (#${b.bidder.paddle})` : ''),
      el('td', {}, b.amount ?? 'hidden', b.max ? ` / max ${b.max}` : '', b.originalAmount ? ` (asked ${b.originalAmount})` : ''),
      el('td', {}, el('span', { class: 'tag' }, b.status), b.kind === 'buy_now' ? ' buy now' : '', b.reason ? ` ${b.reason}` : ''),
      el('td', {},
        owner && b.status === 'accepted' && item.state.status === 'open' ? el('button', { class: 'danger', onclick: async () => {
          const reason = prompt('Reason for cancelling this bid?');
          if (reason && await attempt(() => api('POST', `/api/auctions/${aid}/items/${item.id}/bids/${b.id}/cancel`, { reason }), 'Bid cancelled')) load();
        } }, 'Cancel') : null,
        b.bidder.you && b.status === 'pending' ? el('button', { class: 'ghost', onclick: async () => {
          if (await attempt(() => api('DELETE', `/api/auctions/${aid}/items/${item.id}/bids/${b.id}`), 'Withdrawn')) load();
        } }, 'Withdraw') : null)));
    return el('div', {}, historyVisible ? null : el('p', { class: 'muted' }, 'Only your own bids are shown here.'),
      tableOf(el('tr', {}, ['Time', 'Bidder', 'Amount', 'Status', ''].map((h) => el('th', {}, h))), rows));
  }

  // ── Owner panel ──
  let ownerTab = 'Pending';
  function renderOwner() {
    const tabs = el('div', { class: 'tabs' });
    const body = el('div');
    const views = {
      Pending: pendingView, Bidders: biddersView, 'Add items': addItemView, Settings: settingsView,
      Invoices: invoicesView, Analytics: analyticsView, History: historyView, Manage: manageView,
    };
    const show = async (name) => {
      ownerTab = name;
      [...tabs.children].forEach((b) => b.classList.toggle('on', b.textContent === name));
      body.replaceChildren(await views[name]());
    };
    for (const n of Object.keys(views)) tabs.append(el('button', { onclick: () => show(n) }, n));
    const actions = el('div', { class: 'row' });
    if (auction.status === 'draft') actions.append(el('button', { onclick: async () => { if (await attempt(() => api('POST', `/api/auctions/${aid}/publish`), 'Published')) load(); } }, 'Publish'));
    ownerBox.replaceChildren(el('div', { class: 'card stack' }, el('div', { class: 'row' }, el('h2', {}, 'Owner controls'), actions), tabs, body));
    show(ownerTab);
  }

  async function pendingView() {
    const { pending } = await api('GET', `/api/auctions/${aid}/pending`);
    if (!pending.length) return el('p', { class: 'muted' }, 'No bids waiting.');
    const title = (iid) => items.find((i) => i.id === iid)?.title ?? iid;
    return tableOf(el('tr', {}, ['Item', 'Bidder', 'Amount', 'Placed', ''].map((h) => el('th', {}, h))),
      pending.map((b) => {
        const amount = el('input', { type: 'number', value: b.amount });
        const decide = async (approve) => {
          const body = { approve };
          if (approve && Number(amount.value) !== b.amount) body.amount = Number(amount.value);
          if (!approve) body.reason = prompt('Reason (optional)') || undefined;
          if (await attempt(() => api('POST', `/api/auctions/${aid}/items/${b.itemId}/bids/${b.id}/decision`, body), approve ? 'Approved' : 'Rejected')) load();
        };
        return el('tr', {}, el('td', {}, title(b.itemId)), el('td', {}, b.bidder.label), el('td', {}, amount, b.max ? ` max ${b.max}` : ''),
          el('td', {}, when(b.placedAt)), el('td', {}, el('button', { onclick: () => decide(true) }, 'Approve'), ' ', el('button', { class: 'danger', onclick: () => decide(false) }, 'Reject')));
      }));
  }

  async function biddersView() {
    const { registrations } = await api('GET', `/api/auctions/${aid}/registrations`);
    if (!registrations.length) return el('p', { class: 'muted' }, 'No one has registered yet.');
    const fields = Object.keys(auction.rules.visibility);
    return el('div', { class: 'stack' }, registrations.map((r) => {
      const patch = (body, msg) => attempt(() => api('PATCH', `/api/auctions/${aid}/registrations/${r.uid}`, body), msg).then((ok) => ok && load());
      const delta = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'e.g. 100 or -50', 'aria-label': 'Amount to add or take away' });
      const reason = el('input', { placeholder: 'Reason (shown in the ledger)', 'aria-label': 'Reason' });
      const groups = el('input', { value: r.groups.join(', '), placeholder: 'e.g. vip, dealers', 'aria-label': 'Groups' });
      const limit = el('input', { type: 'number', inputmode: 'numeric', value: r.bidLimit ?? '', placeholder: 'no cap', 'aria-label': 'Spending cap' });
      const see = el('div', { class: 'stack' }, fields.map((f) => {
        const sel = el('select', { onchange: () => patch({ see: { [f]: sel.value === '' ? null : sel.value === 'show' } }, 'Visibility updated') },
          el('option', { value: '' }, 'Auction setting'), el('option', { value: 'show' }, 'Always show'), el('option', { value: 'hide' }, 'Always hide'));
        sel.value = r.see[f] === true ? 'show' : r.see[f] === false ? 'hide' : '';
        return el('label', { class: 'row see' }, el('span', { class: 'grow' }, VISIBILITY[f] ?? f), sel);
      }));
      return el('div', { class: 'card stack' },
        el('div', { class: 'row' }, el('strong', {}, `${r.alias} (#${r.paddle})`), el('span', { class: 'muted' }, `${r.name} · ${r.email}`), el('span', { class: 'tag' }, r.status), r.muted ? el('span', { class: 'tag bad' }, 'muted') : null),
        el('div', { class: 'row' },
          r.status !== 'approved' ? el('button', { onclick: () => patch({ status: 'approved' }, 'Approved') }, 'Approve') : null,
          r.status !== 'blocked' ? el('button', { class: 'danger', onclick: () => patch({ status: 'blocked' }, 'Blocked') }, 'Block') : null,
          el('button', { class: 'ghost', onclick: () => patch({ muted: !r.muted }, r.muted ? 'Unmuted' : 'Muted') }, r.muted ? 'Unmute' : 'Mute in chat')),
        el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Groups'), groups,
          el('button', { class: 'ghost', onclick: () => patch({ groups: groups.value.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean) }, 'Groups saved') }, 'Save')),
        el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Spending cap'), limit,
          el('button', { class: 'ghost', onclick: () => patch({ bidLimit: limit.value ? Number(limit.value) : null }, 'Cap saved') }, 'Save')),
        auction.rules.balance.enabled ? el('div', { class: 'row' },
          el('span', {}, `Balance ${r.balance.balance} · available ${r.balance.available} · held for bids ${r.balance.committed}`),
          delta, reason, el('button', { onclick: async () => {
            if (!Number(delta.value)) return toast('Enter an amount to add (or a minus amount to take away)', true);
            if (await attempt(() => api('POST', `/api/auctions/${aid}/balances/${r.uid}`, { delta: Number(delta.value), reason: reason.value }), 'Balance updated')) load();
          } }, 'Apply')) : null,
        el('details', {}, el('summary', {}, 'What this bidder can see'), el('p', { class: 'muted' }, 'Overrides the auction setting for this bidder only.'), see));
    }));
  }

  // One form to add or edit an item: details as rows, custom settings as a form.
  function itemForm(existing) {
    const title = el('input', { value: existing?.title ?? '', placeholder: 'e.g. Walnut sideboard', maxlength: 120 });
    const lot = el('input', { value: existing?.lot ?? '', placeholder: 'e.g. 12', maxlength: 20, size: 6 });
    const desc = el('textarea', { rows: 3, class: 'plain', maxlength: 5000, value: existing?.description ?? '', placeholder: 'Condition, size, history…' });
    const rows = el('div', { class: 'stack' });
    const addRow = (k = '', v = '') => {
      const row = el('div', { class: 'row kv' },
        el('input', { value: k, placeholder: 'e.g. Condition', maxlength: 40, 'aria-label': 'Detail name' }),
        el('input', { value: v, placeholder: 'e.g. Good', maxlength: 500, 'aria-label': 'Detail value' }),
        el('button', { type: 'button', class: 'ghost', 'aria-label': 'Remove detail', onclick: () => row.remove() }, '✕'));
      rows.append(row);
    };
    for (const [k, v] of Object.entries(existing?.fields ?? {})) addRow(k, v);
    const custom = el('input', { type: 'checkbox', checked: !!existing?.overrides });
    const form = rulesForm(merge(auction.rules, existing?.overrides ?? {}), { mode: 'item', base: auction.rules, locked: existing?.state.status === 'open' });
    const formBox = el('div', { class: 'card inset', hidden: !existing?.overrides }, el('p', { class: 'muted' }, 'Only what you change here differs from the auction settings.'), form.node);
    custom.onchange = () => { formBox.hidden = !custom.checked; };
    return el('div', { class: 'stack' },
      el('div', { class: 'row' }, el('label', { class: 'field grow' }, el('span', { class: 'label' }, 'Title'), title),
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Lot number'), lot)),
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Description'), desc),
      el('div', { class: 'field' }, el('span', { class: 'label' }, 'Details'), el('div', { class: 'help muted' }, 'Shown on the item, like "Condition: Good". Up to 30.'), rows,
        el('button', { type: 'button', class: 'ghost', onclick: () => addRow() }, '+ Add a detail')),
      el('label', { class: 'check' }, custom, ' Different settings for this item (type, price, bid steps, approval, times)'),
      formBox,
      el('button', { class: 'main', onclick: async () => {
        if (!title.value.trim()) { title.focus(); return toast('Give the item a title', true); }
        const fields = {};
        for (const row of rows.children) {
          const [k, v] = row.querySelectorAll('input');
          if (k.value.trim()) fields[k.value.trim()] = v.value.trim();
        }
        const body = { title: title.value.trim(), fields, lot: existing ? lot.value.trim() : lot.value.trim() || undefined, description: existing ? desc.value : desc.value || undefined };
        const overrides = custom.checked ? form.value() : null;
        // Only send overrides when they change: open items refuse timing and format changes.
        if (JSON.stringify(overrides) !== JSON.stringify(existing?.overrides ?? null)) body.overrides = overrides;
        const out = await saveWith(form, () => (existing
          ? api('PATCH', `/api/auctions/${aid}/items/${existing.id}`, body)
          : api('POST', `/api/auctions/${aid}/items`, body)), existing ? 'Item saved' : 'Item added');
        if (out) load();
      } }, existing ? 'Save item' : 'Add item'));
  }

  const CSV_EXAMPLE = 'title,description,lot,start,reserve,buy_now,closes_at,field:condition\nBrass lamp,Art deco table lamp,1,10,50,,,good\nOak chair,,2,5,,40,,fair\n';

  function addItemView() {
    const csvText = el('textarea', { rows: 6, placeholder: CSV_EXAMPLE });
    const chosen = el('span', { class: 'muted' });
    const csvFile = el('input', { type: 'file', accept: '.csv,text/csv', onchange: async () => {
      csvText.value = await csvFile.files[0].text();
      chosen.textContent = `${csvText.value.trim().split('\n').length - 1} rows ready`;
    } });
    return el('div', { class: 'stack' },
      el('h3', {}, 'Add one item'), itemForm(null),
      el('h3', {}, 'Add many items from a spreadsheet'),
      el('p', { class: 'muted' }, 'Save your sheet as CSV. Columns: title (required), description, lot, start, reserve, buy_now, closes_at, media, and field:<name> for details. Every row is added, or none are if one has a mistake.'),
      el('div', { class: 'row' }, el('button', { class: 'ghost', onclick: () => downloadText('items-example.csv', CSV_EXAMPLE) }, '⬇ Example CSV'), csvFile, chosen),
      el('details', {}, el('summary', {}, 'Or paste the CSV text'), csvText),
      el('button', { onclick: async () => {
        if (!csvText.value.trim()) return toast('Choose a CSV file first', true);
        try {
          const out = await api('POST', `/api/auctions/${aid}/items/import`, { csv: csvText.value });
          toast(`Added ${out.imported} items`);
          load();
        } catch (err) {
          toast(err.errors ? `${err.message}: ${err.errors.map((e) => `row ${e.row}: ${e.message}`).join('; ')}` : err.message, true);
        }
      } }, 'Add items from CSV'));
  }

  async function settingsView() {
    const { registrations } = await api('GET', `/api/auctions/${aid}/registrations`).catch(() => ({ registrations: [] }));
    const groups = [...new Set(registrations.flatMap((r) => r.groups))];
    const form = rulesForm(auction.rules, { locked: auction.status === 'live', groups });
    return el('div', { class: 'stack' }, form.node, el('button', { class: 'main', onclick: async () => {
      const rules = form.value();
      if (auction.status === 'live') { delete rules.timing; delete rules.format; }
      if (await saveWith(form, () => api('PATCH', `/api/auctions/${aid}`, { rules }), 'Settings saved')) load();
    } }, 'Save settings'));
  }
  async function invoicesView() {
    const { invoices } = await api('GET', `/api/auctions/${aid}/invoices`);
    if (!invoices.length) return el('p', { class: 'muted' }, 'Nothing sold yet.');
    return el('div', { class: 'stack' }, invoices.map((inv) => el('div', { class: 'card' }, invoiceTable(inv, true))));
  }

  async function analyticsView() {
    const { analytics: a } = await api('GET', `/api/auctions/${aid}/analytics`);
    const t = a.totals;
    const stat = (label, value) => el('div', { class: 'card', style: 'margin:0' }, el('div', { class: 'muted' }, label), el('div', { class: 'price' }, value));
    const hours = Object.entries(a.bidsByHour).sort();
    const peak = Math.max(1, ...hours.map(([, n]) => n));
    return el('div', { class: 'stack' },
      el('div', { class: 'grid' },
        stat('Revenue', money(t.revenue, t.currency)), stat('Sell-through', t.sellThrough == null ? '—' : `${Math.round(t.sellThrough * 100)}%`),
        stat('Sold / closed / open', `${t.sold} / ${t.closed} / ${t.open}`), stat('Bids · bidders', `${t.bids} · ${t.bidders}`),
        stat('Registrations (approved)', `${t.registrations} (${t.approved})`), stat('Page views', t.views), stat('Chat messages', t.chatMessages)),
      el('h3', {}, 'Bids per hour (UTC)'),
      hours.length ? el('div', { class: 'stack' }, hours.map(([h, n]) => el('div', { class: 'row' }, el('span', { class: 'muted', style: 'width:130px' }, h.replace('T', ' ')),
        el('div', { style: `height:12px;width:${Math.round((n / peak) * 300)}px;background:var(--accent);border-radius:3px` }), el('span', {}, n)))) : el('p', { class: 'muted' }, 'No bids yet.'),
      el('h3', {}, 'Items'),
      tableOf(el('tr', {}, ['Item', 'Format', 'Status', 'Bids', 'Bidders', 'Watchers', 'Price', 'Outcome'].map((h) => el('th', {}, h))),
        a.items.map((i) => el('tr', {}, el('td', {}, i.title), el('td', {}, i.format), el('td', {}, i.status), el('td', {}, i.bids), el('td', {}, i.bidders),
          el('td', {}, i.watchers), el('td', {}, i.price ?? '—'), el('td', {}, i.outcome ? `${i.outcome.replace(/_/g, ' ')}${i.via && i.via !== 'auction' ? ` (${i.via})` : ''}` : '—')))));
  }

  async function historyView() {
    const { entries } = await api('GET', `/api/auctions/${aid}/history?limit=200`);
    return el('div', { class: 'stack' },
      el('div', { class: 'row' }, ['bids', 'ledger', 'history', 'chat'].map((type) => el('button', { class: 'ghost', onclick: () => download(`/api/auctions/${aid}/export?type=${type}`, `${aid.slice(0, 8)}-${type}.csv`) }, `Download ${type}.csv`))),
      tableOf(el('tr', {}, ['Time', 'Who', 'Action', 'Details'].map((h) => el('th', {}, h))),
        entries.map(({ id, at, actor, actorName, action, ...rest }) => el('tr', {}, el('td', {}, when(at)), el('td', {}, actorName ?? actor), el('td', {}, action), el('td', { class: 'muted wrap' }, Object.entries(rest).map(([k, v]) => `${k}: ${v && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))))));
  }

  function manageView() {
    const name = el('input', { placeholder: 'Template name' });
    const cloneTitle = el('input', { placeholder: 'Title for the copy', value: `${auction.title} (copy)` });
    const withItems = el('input', { type: 'checkbox', checked: true });
    return el('div', { class: 'stack' },
      el('h3', {}, 'Save these settings as a template'),
      el('div', { class: 'row' }, name, el('button', { onclick: () => attempt(() => api('POST', '/api/templates', { name: name.value, fromAuction: aid }), 'Template saved') }, 'Save template')),
      el('h3', {}, 'Clone'),
      el('div', { class: 'row' }, cloneTitle, el('label', {}, withItems, ' with items'), el('button', { onclick: async () => {
        const out = await attempt(() => api('POST', `/api/auctions/${aid}/clone`, { title: cloneTitle.value, withItems: withItems.checked }), 'Cloned');
        if (out) location.hash = `#/a/${out.auction.id}`;
      } }, 'Clone as draft')),
      auction.status === 'draft' ? el('div', { class: 'stack' }, el('h3', {}, 'Delete'), el('button', { class: 'danger', onclick: async () => {
        if (!window.confirm('Delete this draft and its items? This cannot be undone.')) return;
        if (await attempt(() => api('DELETE', `/api/auctions/${aid}`), 'Draft deleted')) location.hash = '#/';
      } }, 'Delete draft')) : el('p', { class: 'muted' }, 'Published auctions keep their history and cannot be deleted.'));
  }

  // ── Chat ──
  const chatBox = el('div', { id: 'chat', class: 'card stack' });
  const log = el('div', { class: 'log' });
  let lastId = null;
  async function loadChat(catchUp) {
    const qs = catchUp && lastId ? `?after=${lastId}` : '';
    let data;
    try { data = await api('GET', `/api/auctions/${aid}/chat${qs}`); } catch (err) {
      chatBox.replaceChildren(el('h2', {}, 'Chat'), el('p', { class: 'muted' }, err.message));
      return;
    }
    if (!catchUp) log.replaceChildren();
    for (const m of data.messages) addMessage(m);
    renderComposer(data.canPost);
  }
  function addMessage(m) {
    const existing = log.querySelector(`[data-id="${m.id}"]`);
    const node = el('div', { class: `msg ${m.role === 'host' ? 'host' : ''} ${m.mine ? 'mine' : ''}`, 'data-id': m.id },
      el('div', { class: 'meta' }, el('strong', {}, m.author), m.paddle != null ? `#${m.paddle}` : null, new Date(m.at).toLocaleTimeString(),
        (auction.you.owner || m.mine) && !m.deleted ? el('button', { class: 'ghost', onclick: () => attempt(() => api('DELETE', `/api/auctions/${aid}/chat/${m.id}`)).then(() => loadChat(false)) }, 'delete') : null),
      el('div', { class: m.deleted ? 'muted' : '' }, m.deleted ? 'message removed' : m.text));
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (existing) existing.replaceWith(node); else log.append(node);
    if (!lastId || m.id > lastId) lastId = m.id;
    if (nearBottom || m.mine) log.scrollTop = log.scrollHeight;
    if (!existing && !m.mine && !chatInView) fabDot.hidden = false;
  }
  const composer = el('div', { class: 'row' });
  function renderComposer(canPost) {
    if (!canPost) { composer.replaceChildren(el('span', { class: 'muted' }, me ? 'You can read this chat but not post.' : 'Sign in to chat.')); return; }
    const input = el('input', { placeholder: 'Message', maxlength: auction.rules.chat?.maxLength ?? 500, enterkeyhint: 'send', autocomplete: 'off', 'aria-label': 'Chat message' });
    const send = async () => {
      if (!input.value.trim()) return;
      const out = await attempt(() => api('POST', `/api/auctions/${aid}/chat`, { text: input.value }));
      if (out) { input.value = ''; addMessage(out.message); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    composer.replaceChildren(input, el('button', { onclick: send }, 'Send'));
    composer.className = 'row composer';
  }
  chatBox.append(el('h2', {}, 'Live chat'), log, composer);
  // Phones: the chat sits below the items, so a floating button jumps to it and shows unread.
  let chatInView = false;
  const fabDot = el('span', { class: 'dot', hidden: true });
  const fab = el('button', { id: 'chat-fab', 'aria-label': 'Open chat', onclick: () => chatBox.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '💬 Chat', fabDot);
  const seen = new IntersectionObserver(([entry]) => {
    chatInView = entry.isIntersecting;
    fab.hidden = chatInView;
    if (chatInView) fabDot.hidden = true;
  });
  seen.observe(chatBox);
  teardown.push(() => { seen.disconnect(); fab.remove(); });

  await load();
  if (auction.locked) return lockedView();

  // ── Live wiring ──
  let reloadTimer = null;
  const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => load().catch(() => {}), 300); };
  teardown.push(live.subscribe(`/public/auction/${aid}`, 'public', (e) => {
    if (e.type === 'chat') addMessage({ ...e.message, mine: false });
    else if (e.type === 'chat_ping') loadChat(true);
    else reloadSoon();
  }));
  const onUser = (e) => { if (e.aid === aid) reloadSoon(); };
  userHandlers.add(onUser);
  teardown.push(() => userHandlers.delete(onUser));
  // Countdowns tick every second; a dutch price drop triggers a reload.
  const ticker = setInterval(() => {
    root.querySelectorAll('[data-closes]').forEach((n) => {
      const at = Number(n.dataset.closes);
      const text = left(at);
      if (n.tagName === 'TD') n.textContent = text;
      else n.textContent = n.textContent.startsWith('next drop') ? `next drop ${text}` : `⏱ ${text}`;
      if (!n.textContent.startsWith('next drop')) n.classList.toggle('urgent', urgent(at));
    });
    if (items.some((i) => i.state.dutch?.nextDropAt && i.state.dutch.nextDropAt - clockSkew <= Date.now())) reloadSoon();
  }, 1000);
  teardown.push(() => clearInterval(ticker));
  refresh = () => { reloadSoon(); loadChat(true); };

  root.append(el('div', { class: 'layout' }, el('div', {}, head, ownerBox, itemsBox), el('aside', {}, chatBox)), fab);
  loadChat(false);
  return root;
}

route();
