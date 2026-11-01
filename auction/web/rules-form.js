// Rules editor: every auction setting as a plain-language form. Fields that
// don't apply to the chosen format are hidden. The server still validates
// everything; a rejected field is highlighted with the server's message.

import { el, merge, diff } from './dom.js';

export const FORMATS = {
  english: ['Classic auction', 'Bids go up. The highest bid when time runs out wins.'],
  sealed_first: ['Sealed bids', 'Everyone places one hidden bid. The highest wins and pays their own bid.'],
  sealed_second: ['Sealed, second price', 'One hidden bid each. The highest wins but pays the second-highest bid.'],
  dutch: ['Falling price', 'The price drops on a timer. The first person to accept buys it.'],
  reverse: ['Reverse (lowest wins)', 'Sellers bid the price down. The lowest bid wins. For buying goods or services.'],
  fixed_price: ['Fixed price', 'A set price anyone can buy at. You can also accept offers.'],
};

export const AUDIENCES = [['public', 'Everyone'], ['registered', 'Registered bidders'], ['approved', 'Approved bidders'], ['owner', 'Only me']];

export const VISIBILITY = {
  price: 'Current price',
  bidCount: 'Number of bids',
  nextMin: 'Next minimum bid',
  closesAt: 'Closing time',
  leader: 'Who is winning',
  history: 'List of bids',
  historyAmounts: 'Amounts in the bid list',
  historyIdentities: 'Real bidder names (others see "Bidder 1, 2…")',
  reserveAmount: 'Reserve price amount',
  reserveStatus: 'Whether the reserve is met',
  participants: 'List of registered bidders',
};

export const COLUMNS = { rank: 'Rank', bidder: 'Bidder', amount: 'Amount', time: 'Time', status: 'Status', bids: 'Number of bids' };
const IDENTITY = [['alias', 'Nickname they choose'], ['paddle', 'Paddle number'], ['name', 'Real name']];

const is = (...formats) => (r) => formats.includes(r.format);
const not = (...formats) => (r) => !formats.includes(r.format);
const softClose = (r) => is('english', 'reverse')(r) && r.timing.softClose.windowSec > 0;
const approving = (r) => not('dutch', 'fixed_price')(r) && r.bidApproval.mode !== 'none';

// item: true = an item may override it (sections with itemAll override every field).
const SECTIONS = [
  { id: 'format', title: 'Auction type', open: true, itemAll: true, fields: [{ path: 'format', type: 'format', timing: true }] },
  { id: 'timing', title: 'When it runs', open: true, fields: [
    { path: 'timing.opensAt', label: 'Opens', type: 'datetime', nullable: true, help: 'Leave empty to open as soon as you publish.', timing: true, item: true },
    { path: 'timing.closesAt', label: 'Closes', type: 'datetime', nullable: true, help: 'Needed before you publish, here or on each item.', timing: true, item: true },
    { path: 'timing.staggerSec', label: 'Close items one after another, every', type: 'number', unit: 'seconds', help: '0 = all items close at the same time. 60 = item 2 closes a minute after item 1, and so on.', timing: true },
    { path: 'timing.softClose.windowSec', label: 'Late-bid protection: a bid in the last', type: 'number', unit: 'seconds', help: 'extends the close so others can answer it. 0 = off.', show: is('english', 'reverse'), timing: true },
    { path: 'timing.softClose.extendSec', label: 'pushes the close to', type: 'number', unit: 'seconds after that bid', show: softClose, timing: true },
    { path: 'timing.softClose.maxExtensions', label: 'At most', type: 'number', unit: 'extensions per item', show: softClose, timing: true },
  ] },
  { id: 'price', title: 'Price', open: true, itemAll: true, fields: [
    { path: 'price.currency', label: 'Currency', type: 'text', upper: true, help: 'For example USD, EUR, INR or CREDITS.' },
    { path: 'price.start', label: (r) => ({ reverse: 'Starting price (the most you will pay)', fixed_price: 'Price' })[r.format] ?? 'Opening bid', type: 'number', min: 1, show: not('dutch') },
    { path: 'price.reserve', label: (r) => (r.format === 'reverse' ? 'Budget limit' : 'Reserve price'), type: 'number', nullable: true, placeholder: 'none',
      help: (r) => (r.format === 'reverse' ? 'It only sells if the lowest bid is at or under this.' : 'It only sells if bidding reaches this. Empty = no reserve.'), show: not('dutch', 'fixed_price') },
    { path: 'price.buyNow.amount', label: 'Buy It Now price', type: 'number', nullable: true, placeholder: 'off', help: 'Anyone can end the auction at once by paying this.', show: is('english') },
    { path: 'price.buyNow.until', label: 'Buy It Now stays available until', type: 'select', options: [['first_bid', 'the first bid'], ['reserve_met', 'the reserve is met'], ['close', 'the auction closes']],
      show: (r) => r.format === 'english' && r.price.buyNow.amount != null },
    { path: 'price.dutch.start', label: 'Starting price', type: 'number', min: 2, show: is('dutch') },
    { path: 'price.dutch.step', label: 'Drop the price by', type: 'number', min: 1, show: is('dutch') },
    { path: 'price.dutch.everySec', label: 'every', type: 'number', unit: 'seconds', min: 1, show: is('dutch') },
    { path: 'price.dutch.floor', label: 'Never below', type: 'number', min: 1, show: is('dutch') },
    { path: 'price.offers.enabled', label: 'Buyers may make offers below the price', type: 'toggle', show: is('fixed_price') },
    { path: 'price.offers.autoAccept', label: 'Accept offers at or above', type: 'number', nullable: true, placeholder: 'decide myself', show: (r) => r.format === 'fixed_price' && r.price.offers.enabled },
    { path: 'price.offers.autoDecline', label: 'Decline offers below', type: 'number', nullable: true, placeholder: 'decide myself', show: (r) => r.format === 'fixed_price' && r.price.offers.enabled },
  ] },
  { id: 'increment', title: 'Bid steps', itemAll: true, show: is('english', 'reverse'), fields: [
    { path: 'increment.mode', label: (r) => (r.format === 'reverse' ? 'Each new bid must be lower by' : 'Each new bid must be higher by'), type: 'select',
      options: (r) => [['fixed', 'a fixed amount'], ['percent', 'a percentage of the price'], ['tiered', 'an amount that depends on the price'], ...(r.format === 'english' ? [['bidder_choice', 'whatever the bidder picks']] : [])] },
    { path: 'increment.fixed', label: 'Amount', type: 'number', min: 1, show: (r) => r.increment.mode === 'fixed' },
    { path: 'increment.percent', label: 'Percentage', type: 'number', unit: '%', min: 1, show: (r) => r.increment.mode === 'percent' },
    { path: 'increment.roundTo', label: 'Round up to the nearest', type: 'number', min: 1, show: (r) => r.increment.mode === 'percent' },
    { path: 'increment.tiers', label: 'Steps by price', type: 'tiers', show: (r) => r.increment.mode === 'tiered' },
    { path: 'increment.bidderChoice.min', label: 'Smallest raise', type: 'number', min: 1, show: (r) => r.increment.mode === 'bidder_choice' },
    { path: 'increment.bidderChoice.max', label: 'Largest raise', type: 'number', nullable: true, placeholder: 'no limit', show: (r) => r.increment.mode === 'bidder_choice' },
    { path: 'increment.bidderChoice.presets', label: 'Quick-pick buttons', type: 'numbers', help: 'Up to 6 amounts, separated by commas.', show: (r) => r.increment.mode === 'bidder_choice' },
    { path: 'increment.confirmAbovePct', label: 'Ask bidders to confirm a bid more than', type: 'number', unit: '% away from the minimum', help: 'Catches typos like an extra zero. 0 = never ask.' },
  ] },
  { id: 'bidding', title: 'Bidding options', fields: [
    { path: 'proxy.enabled', label: 'Automatic bidding: bidders set a maximum and the system bids for them', type: 'toggle', show: is('english'), item: true },
    { path: 'proxy.hostSeesMax', label: "Let me see bidders' maximums", type: 'toggle', show: (r) => r.format === 'english' && r.proxy.enabled, item: true },
    { path: 'limits.bidLimit', label: 'Default spending cap per bidder', type: 'number', nullable: true, placeholder: 'no cap', help: 'You can also set a cap for each bidder.' },
    { path: 'conduct.hostCanBid', label: 'I may bid in my own auction', type: 'toggle' },
  ] },
  { id: 'approval', title: 'Approving bids', itemAll: true, show: not('dutch', 'fixed_price'), fields: [
    { path: 'bidApproval.mode', label: 'Do bids need your approval?', type: 'select', options: [['none', 'No, bids count at once'], ['above', 'Only bids at or above an amount'], ['all', 'Yes, I approve every bid']] },
    { path: 'bidApproval.threshold', label: 'Amount', type: 'number', show: (r) => approving(r) && r.bidApproval.mode === 'above' },
    { path: 'bidApproval.adjust', label: 'May you change the amount when approving?', type: 'select', options: [['none', 'No'], ['lower', 'Only lower it'], ['any', 'Yes, to any amount']], show: approving },
    { path: 'bidApproval.decideWithinSec', label: 'Time to decide after the close', type: 'number', unit: 'minutes', scale: 60, show: approving },
    { path: 'bidApproval.onTimeout', label: "Bids you haven't decided by then", type: 'select', options: [['reject', 'are rejected'], ['approve', 'are approved']], show: approving },
  ] },
  { id: 'access', title: 'Who can join', fields: [
    { path: 'access.mode', label: 'Who can find and join', type: 'select', options: [['public', 'Anyone (listed on the home page)'], ['unlisted', 'Anyone with the link (not listed)'], ['code', 'Private: access code or invite only']] },
    { path: 'access.code', label: 'Access code', type: 'text', nullable: true, placeholder: 'no code', help: '4 or more characters. Share it with the people you want.', show: (r) => r.access.mode === 'code' },
    { path: 'access.invites', label: 'Invited emails', type: 'emails', help: 'One per line. They can join without the code.', show: (r) => r.access.mode === 'code' },
    { path: 'registration', label: 'New bidders', type: 'select', options: [['auto', 'can bid as soon as they join'], ['approval', 'wait for my approval']] },
  ] },
  { id: 'balance', title: 'Bidder balances', show: not('reverse'), fields: [
    { path: 'balance.enabled', label: 'Bidders spend from a balance you give them', type: 'toggle', help: 'You add or take away balance in the Bidders tab.' },
    { path: 'balance.unit', label: 'Name of the balance', type: 'text', show: (r) => r.balance.enabled },
    { path: 'balance.startingCredit', label: 'Give each approved bidder', type: 'number', unit: (r) => r.balance.unit, show: (r) => r.balance.enabled },
    { path: 'balance.enforce', label: "Block bids bigger than the bidder's available balance", type: 'toggle', show: (r) => r.balance.enabled },
    { path: 'balance.allowNegative', label: 'Allow balances below zero', type: 'toggle', show: (r) => r.balance.enabled },
    { path: 'balance.showToBidder', label: 'Bidders can see their balance', type: 'toggle', show: (r) => r.balance.enabled },
  ] },
  { id: 'visibility', title: 'Who sees what', help: 'You always see everything. You can also change this per bidder in the Bidders tab.', fields: [
    ...Object.entries(VISIBILITY).map(([k, label]) => ({ path: `visibility.${k}`, label, type: 'audience' })),
    { path: 'identity', label: 'Show revealed bidders by', type: 'select', options: IDENTITY },
  ] },
  { id: 'board', title: 'Standings table', fields: [
    { path: 'board.enabled', label: 'Show a standings table on each item', type: 'toggle' },
    { path: 'board.audience', label: 'Who can see it', type: 'audience', show: (r) => r.board.enabled },
    { path: 'board.when', label: 'When', type: 'select', options: [['always', 'While bidding and after'], ['after_close', 'Only after the close']], show: (r) => r.board.enabled },
    { path: 'board.columns', label: 'Columns', type: 'columns', show: (r) => r.board.enabled },
  ] },
  { id: 'chat', title: 'Chat', fields: [
    { path: 'chat.enabled', label: 'Live chat for this auction', type: 'toggle' },
    { path: 'chat.hostOnly', label: 'Announcements only: just you can post', type: 'toggle', show: (r) => r.chat.enabled },
    { path: 'chat.read', label: 'Who can read', type: 'audience', show: (r) => r.chat.enabled },
    { path: 'chat.post', label: 'Who can post', type: 'audience', show: (r) => r.chat.enabled && !r.chat.hostOnly },
    { path: 'chat.identity', label: 'Show people by', type: 'select', options: IDENTITY, show: (r) => r.chat.enabled },
    { path: 'chat.slowModeSec', label: 'Wait between messages', type: 'number', unit: 'seconds', show: (r) => r.chat.enabled },
    { path: 'chat.maxLength', label: 'Longest message', type: 'number', unit: 'characters', min: 1, show: (r) => r.chat.enabled },
  ] },
  { id: 'payment', title: 'Payment', fields: [
    { path: 'payment.instructions', label: 'Payment instructions for winners', type: 'textarea', placeholder: 'For example: bank transfer to … within 3 days, or cash at pickup.' },
    { path: 'payment.dueHours', label: 'Payment due within', type: 'number', unit: 'hours' },
  ] },
];

const ITEM_KEYS = ['format', 'price', 'increment', 'proxy', 'bidApproval', 'timing'];
const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function set(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  parts.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}
const text = (v, r) => (typeof v === 'function' ? v(r) : v);
const toLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** Settings that must change together when the format changes. */
function fitFormat(r) {
  if (r.format !== 'english') {
    r.price.buyNow.amount = null;
    if (r.increment.mode === 'bidder_choice') r.increment.mode = 'fixed';
  }
  if (r.format !== 'fixed_price') r.price.offers.enabled = false;
  if (r.format === 'dutch' || r.format === 'fixed_price') r.bidApproval.mode = 'none';
  if (r.format === 'reverse') r.balance.enabled = false;
  if (r.format === 'dutch' && r.price.dutch.start == null) r.price.dutch.start = Math.max(r.price.dutch.floor + 1, r.price.start * 10, 100);
}

/**
 * rulesForm(rules, opts) → { node, value(), flag(path, message) }
 *   mode    'auction' edits whole rules; 'item' edits one item's overrides of `base`
 *   locked  format and timing are read-only (a live auction or open item)
 *   groups  bidder group names to offer in "who sees" pickers
 */
export function rulesForm(rules, { mode = 'auction', base = null, locked = false, groups = [] } = {}) {
  let r = structuredClone(rules);
  const item = mode === 'item';
  const node = el('div', { class: 'rules-form' });
  const open = new Set(SECTIONS.filter((s) => s.open).map((s) => s.id));
  let rows = [];

  function field(f) {
    const wrap = el('div', { class: `field${f.type === 'toggle' ? ' toggle' : ''}`, 'data-path': f.path });
    const label = el('span', { class: 'label' });
    const help = el('div', { class: 'help muted' });
    const unit = el('span', { class: 'unit muted' });
    const disabled = locked && f.timing;
    const changed = (rebuild = false) => { wrap.classList.remove('error'); if (rebuild) render(); else refresh(); };
    let input;
    const v = get(r, f.path);

    switch (f.type) {
      case 'format': {
        input = el('div', { class: 'choices' }, Object.entries(FORMATS).map(([key, [name, about]]) => el('button', {
          type: 'button', class: `choice${r.format === key ? ' on' : ''}`, disabled, 'aria-pressed': String(r.format === key),
          onclick: () => { r.format = key; fitFormat(r); changed(true); },
        }, el('strong', {}, name), el('span', { class: 'muted' }, about))));
        break;
      }
      case 'toggle':
        input = el('input', { type: 'checkbox', checked: v, disabled, onchange: () => { set(r, f.path, input.checked); changed(); } });
        wrap.append(el('label', {}, input, ' ', label), help);
        return { f, wrap, label, help, unit };
      case 'select':
        input = el('select', { disabled, onchange: () => { set(r, f.path, input.value); changed(); } });
        break;
      case 'audience': {
        const custom = el('input', { placeholder: 'group name', size: 12, hidden: true });
        const options = [...AUDIENCES, ...groups.map((g) => [`group:${g}`, `Group: ${g}`])];
        if (typeof v === 'string' && v.startsWith('group:') && !options.some(([k]) => k === v)) options.push([v, `Group: ${v.slice(6)}`]);
        input = el('select', {}, options.map(([k, name]) => el('option', { value: k }, name)), el('option', { value: '__group' }, 'Another group…'));
        input.value = v;
        input.onchange = () => {
          custom.hidden = input.value !== '__group';
          if (!custom.hidden) return custom.focus();
          set(r, f.path, input.value);
          changed();
        };
        custom.onchange = () => {
          const g = custom.value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').slice(0, 24);
          if (g) { set(r, f.path, `group:${g}`); changed(); }
        };
        wrap.append(el('label', {}, label), el('div', { class: 'row' }, input, custom), help);
        return { f, wrap, label, help, unit };
      }
      case 'datetime':
        input = el('input', { type: 'datetime-local', value: toLocal(v), disabled, onchange: () => { set(r, f.path, input.value ? new Date(input.value).toISOString() : null); changed(); } });
        break;
      case 'text':
        input = el('input', { value: v ?? '', placeholder: f.placeholder, disabled, onchange: () => {
          const val = f.upper ? input.value.trim().toUpperCase() : input.value.trim();
          set(r, f.path, val === '' && f.nullable ? null : val);
          changed();
        } });
        break;
      case 'textarea':
        input = el('textarea', { rows: 3, class: 'plain', placeholder: f.placeholder, value: v ?? '', onchange: () => { set(r, f.path, input.value); changed(); } });
        break;
      case 'emails':
        input = el('textarea', { rows: 4, class: 'plain', placeholder: 'ana@example.com', value: (v ?? []).join('\n'), onchange: () => {
          set(r, f.path, input.value.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean));
          changed();
        } });
        break;
      case 'numbers':
        input = el('input', { value: (v ?? []).join(', '), inputmode: 'numeric', onchange: () => {
          set(r, f.path, input.value.split(/[\s,]+/).filter(Boolean).map(Number));
          changed();
        } });
        break;
      case 'columns':
        input = el('div', { class: 'row' }, Object.entries(COLUMNS).map(([k, name]) => {
          const box = el('input', { type: 'checkbox', checked: v.includes(k), onchange: () => {
            set(r, f.path, Object.keys(COLUMNS).filter((c) => (c === k ? box.checked : get(r, f.path).includes(c))));
            changed();
          } });
          return el('label', { class: 'check' }, box, ' ', name);
        }));
        break;
      case 'tiers': {
        const list = el('div', { class: 'stack' });
        const draw = () => {
          const tiers = get(r, f.path);
          list.replaceChildren(...tiers.map((t, i) => {
            const last = i === tiers.length - 1;
            const upTo = el('input', { type: 'number', inputmode: 'numeric', value: t.upTo ?? '', disabled: last, placeholder: 'and above', onchange: () => { t.upTo = upTo.value === '' ? null : Number(upTo.value); changed(); } });
            const step = el('input', { type: 'number', inputmode: 'numeric', value: t.step, onchange: () => { t.step = Number(step.value); changed(); } });
            return el('div', { class: 'row tier' }, el('span', { class: 'muted' }, i === 0 ? 'Below' : last ? 'Above that' : 'Then below'), last ? null : upTo,
              el('span', { class: 'muted' }, 'step'), step,
              tiers.length > 1 ? el('button', { type: 'button', class: 'ghost', 'aria-label': 'Remove tier', onclick: () => {
                tiers.splice(i, 1);
                tiers.at(-1).upTo = null;
                draw();
                changed();
              } }, '✕') : null);
          }));
        };
        draw();
        input = el('div', { class: 'stack' }, list, el('button', { type: 'button', class: 'ghost', disabled, onclick: () => {
          const tiers = get(r, f.path);
          const prev = tiers.at(-2)?.upTo ?? 0;
          tiers.splice(tiers.length - 1, 0, { upTo: prev ? prev * 10 : 100, step: tiers.at(-1).step });
          draw();
          changed();
        } }, '+ Add a price band'));
        break;
      }
      default: { // number
        const scale = f.scale ?? 1;
        input = el('input', { type: 'number', inputmode: 'numeric', min: f.min ?? 0, step: scale === 1 ? 1 : 'any', placeholder: f.placeholder,
          value: v == null ? '' : v / scale, disabled, onchange: () => {
            if (input.value === '') { if (f.nullable) set(r, f.path, null); } else set(r, f.path, Math.round(Number(input.value) * scale));
            changed();
          } });
      }
    }
    if (f.type === 'select') input.value = v;
    wrap.append(el('label', {}, label), f.type === 'format' ? input : el('div', { class: 'row control' }, input, unit), help);
    return { f, wrap, label, help, unit, input };
  }

  function fillOptions(row) {
    if (row.f.type !== 'select') return;
    const opts = text(row.f.options, r);
    const key = JSON.stringify(opts);
    if (row.input.dataset.opts !== key) {
      row.input.replaceChildren(...opts.map(([k, name]) => el('option', { value: k }, name)));
      row.input.dataset.opts = key;
    }
    row.input.value = get(r, row.f.path);
  }

  function refresh() {
    for (const row of rows) {
      row.label.textContent = text(row.f.label, r) ?? '';
      row.help.textContent = text(row.f.help, r) ?? '';
      row.help.hidden = !row.help.textContent;
      row.unit.textContent = text(row.f.unit, r) ?? '';
      row.wrap.hidden = !!row.f.show && !row.f.show(r);
      fillOptions(row);
    }
    for (const sec of node.querySelectorAll('details.section[data-id]')) {
      const def = SECTIONS.find((s) => s.id === sec.dataset.id);
      sec.hidden = (def.show && !def.show(r)) || ![...sec.querySelectorAll('.field')].some((w) => !w.hidden);
    }
    json.value = JSON.stringify(item ? value() ?? {} : r, null, 2);
  }

  const json = el('textarea', { rows: 14, spellcheck: 'false' });
  const advanced = el('details', { class: 'section advanced' }, el('summary', {}, 'Advanced: edit as JSON'),
    el('p', { class: 'muted' }, item ? 'Only the settings that differ from the auction.' : 'Every setting at once, for copying between auctions.'),
    json, el('button', { type: 'button', class: 'ghost', onclick: () => {
      let parsed;
      try { parsed = JSON.parse(json.value || '{}'); } catch { json.classList.add('bad'); return; }
      json.classList.remove('bad');
      r = item ? merge(base, parsed) : merge(r, parsed);
      render();
    } }, 'Apply JSON'));

  function render() {
    rows = [];
    const parts = [];
    if (locked) parts.push(el('p', { class: 'muted' }, '🔒 The auction type and timing are locked while bidding is open.'));
    for (const sec of SECTIONS) {
      const fields = sec.fields.filter((f) => !item || sec.itemAll || f.item);
      if (!fields.length) continue;
      const built = fields.map(field);
      rows.push(...built);
      const box = el('details', { class: 'section', 'data-id': sec.id, open: open.has(sec.id),
        ontoggle: (e) => (e.target.open ? open.add(sec.id) : open.delete(sec.id)) },
      el('summary', {}, sec.title), sec.help ? el('p', { class: 'muted' }, sec.help) : null, built.map((b) => b.wrap));
      parts.push(box);
    }
    node.replaceChildren(...parts, advanced);
    refresh();
  }

  function value() {
    if (!item) return structuredClone(r);
    const out = diff(base, r) ?? {};
    for (const k of Object.keys(out)) if (!ITEM_KEYS.includes(k)) delete out[k];
    if (out.timing) {
      for (const k of Object.keys(out.timing)) if (!['opensAt', 'closesAt'].includes(k)) delete out.timing[k];
      if (!Object.keys(out.timing).length) delete out.timing;
    }
    return Object.keys(out).length ? out : null;
  }

  /** Highlights the field the server rejected, e.g. path "price.reserve". */
  function flag(path, message) {
    const wrap = [...node.querySelectorAll('.field')].find((w) => path === w.dataset.path || path.startsWith(`${w.dataset.path}.`) || path.startsWith(`${w.dataset.path}[`));
    if (!wrap) return false;
    const sec = wrap.closest('details.section');
    if (sec) sec.open = true;
    wrap.classList.add('error');
    const help = wrap.querySelector('.help');
    help.hidden = false;
    help.textContent = message.replace(/^[^:]+:\s*/, '');
    wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  render();
  return { node, value, flag };
}
