// Business operations. Each one loads what it needs, runs the rules engine,
// and commits in one DynamoDB transaction, so a bid, its balance hold and
// its audit row land together or not at all.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  keys, get, update, query, queryIndex, batchGet, Tx, TxConflict, withRetry, newId,
} from './db.mjs';
import {
  DEFAULT_RULES, MAX_AMOUNT, RuleError, mergeRules, validateRules, validateOverrides,
  effectiveRules, initialState, evaluateBid, needsApproval, replay, nextMin,
  isSealed, sealedResult, closeOutcome, buyNowPrice, offerVerdict,
} from './rules.mjs';
import { allowed, tagOf } from './visibility.mjs';
import {
  badRequest, conflict, forbidden, notFound, unauthorized, str, int, bool, oneOf,
} from './http.mjs';
import { scheduleClose } from './aws.mjs';

export const SYSTEM = Object.freeze({ uid: 'system', name: 'System' });
const iso = (ms) => new Date(ms).toISOString();
export const actorOf = (user) => ({ uid: user.uid, name: user.name });

// ── Loading and permissions ───────────────────────────────────────────

/** Auction + the caller's role in it. Drafts are invisible to everyone but the owner. */
export async function loadAuction(aid, user) {
  const meta = await get(keys.auction(aid));
  if (!meta) throw notFound('Auction not found');
  const owner = !!user && (meta.hostId === user.uid || user.admin);
  if (meta.status === 'draft' && !owner) throw notFound('Auction not found');
  const reg = user ? (await get(keys.reg(aid, user.uid))) ?? null : null;
  // A code auction shows only its title until the viewer joins with the code or an invite.
  const locked = meta.rules.access.mode === 'code' && !owner && (!reg || reg.status === 'blocked');
  return { meta, rules: meta.rules, user, locked, viewer: { uid: user?.uid ?? null, owner, reg } };
}

const listed = (rules) => rules.access.mode === 'public';

export function requireOwner(ctx) {
  if (!ctx.user) throw unauthorized();
  if (!ctx.viewer.owner) throw forbidden('Only the auction owner can do that');
}

export function log(tx, aid, actor, action, details = {}, now = Date.now()) {
  tx.put({ ...keys.log(aid, newId(now)), aid, at: now, actor: actor.uid, actorName: actor.name, action, ...details });
}

/** Every path whose value differs between two configs, e.g. ["chat.read"]. */
export function diffPaths(a, b, prefix = '') {
  const paths = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(a?.[k]) && isObj(b?.[k])) paths.push(...diffPaths(a[k], b[k], p));
    else if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) paths.push(p);
  }
  return paths;
}

export function stateRow(iid, aid, s) {
  const open = s.status === 'open';
  const { PK, SK, GSI1PK, GSI1SK, ...clean } = s;
  return {
    ...keys.state(iid), ...clean, iid, aid,
    ...(open ? { GSI1PK: 'STATUS#open', GSI1SK: iso(s.closesAt) } : {}),
  };
}

/** Put a new STATE version, guarded by the version it was computed from. */
function putState(tx, iid, aid, prev, next) {
  const row = stateRow(iid, aid, { ...next, version: (prev.version ?? 0) + 1 });
  tx.put(row, { condition: '#v = :v', names: { '#v': 'version' }, values: { ':v': prev.version ?? 0 }, reason: 'retry' });
  return row;
}

// ── Balances ──────────────────────────────────────────────────────────

/**
 * Moves `delta` from available to committed (a hold) on a bidder's balance;
 * a negative delta releases. With enforce, a hold the bidder can't cover
 * fails the whole transaction.
 */
function hold(tx, aid, uid, delta, { enforce = false, now }) {
  if (!delta) return;
  tx.update(keys.balance(aid, uid), {
    set: [
      'available = if_not_exists(available, :z) - :d',
      'committed = if_not_exists(committed, :z) + :d',
      'balance = if_not_exists(balance, :z)',
      '#v = if_not_exists(#v, :z) + :one',
      'uid = :uid', 'aid = :aid', 'updatedAt = :now',
    ],
    condition: enforce && delta > 0 ? 'available >= :d' : undefined,
    names: { '#v': 'version' },
    values: { ':z': 0, ':d': delta, ':one': 1, ':uid': uid, ':aid': aid, ':now': now },
    reason: 'insufficient_balance',
  });
}

/** Moves holds when the leader or the leader's maximum changes. */
function moveHolds(tx, aid, prev, next, rules, now) {
  const oldHold = prev.leaderHold ?? 0;
  const newHold = rules.balance.enabled && next.leaderId ? next.leaderMax : 0;
  next.leaderHold = newHold;
  const enforce = rules.balance.enabled && rules.balance.enforce;
  if (prev.leaderId && prev.leaderId === next.leaderId) {
    hold(tx, aid, next.leaderId, newHold - oldHold, { enforce, now });
  } else {
    if (prev.leaderId) hold(tx, aid, prev.leaderId, -oldHold, { now });
    if (next.leaderId) hold(tx, aid, next.leaderId, newHold, { enforce, now });
  }
}

function checkFunds(rules, bal, needed) {
  if (!rules.balance.enabled || !rules.balance.enforce || needed <= 0) return;
  const available = bal?.available ?? 0;
  if (available < needed) {
    throw conflict('insufficient_balance', `Not enough ${rules.balance.unit}: ${available} available, ${needed} needed`, { available, needed });
  }
}

/** Owner credits (+) or debits (-) a bidder's balance. Every change is a ledger row. */
export async function adjustBalance(ctx, uid, body, now = Date.now()) {
  requireOwner(ctx);
  const delta = body.delta;
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_AMOUNT) {
    throw badRequest('invalid', 'delta must be a non-zero whole number', { field: 'delta' });
  }
  const reason = str(body.reason, 'reason', { min: 1, max: 200 });
  const { meta, rules } = ctx;
  if (!rules.balance.enabled) throw conflict('balance_disabled', 'Turn on balance in the auction rules first');
  const reg = await get(keys.reg(meta.aid, uid));
  if (!reg) throw notFound('That bidder is not registered in this auction');
  return withRetry(async () => {
    const tx = new Tx();
    const row = credit(tx, meta.aid, uid, await get(keys.balance(meta.aid, uid)), delta, {
      type: delta > 0 ? 'credit' : 'debit', reason, actor: actorOf(ctx.user), allowNegative: rules.balance.allowNegative, now,
    });
    log(tx, meta.aid, actorOf(ctx.user), 'balance.adjusted', { target: uid, delta, reason, balanceAfter: row.balance }, now);
    await tx.run();
    return row;
  });
}

/** Adds a balance change + ledger row to tx. Guarded by the row's version. */
function credit(tx, aid, uid, bal, delta, { type, reason, actor, allowNegative = false, now, iid }) {
  const cur = bal ?? { balance: 0, available: 0, committed: 0, version: 0 };
  const row = {
    ...keys.balance(aid, uid), aid, uid,
    balance: cur.balance + delta,
    available: cur.available + delta,
    committed: cur.committed ?? 0,
    version: (cur.version ?? 0) + 1,
    updatedAt: now,
  };
  if (delta < 0 && !allowNegative && row.available < 0) {
    throw conflict('insufficient_balance', `Only ${cur.available} is available (the rest is held for leading bids)`, { available: cur.available });
  }
  tx.put(row, bal
    ? { condition: '#v = :v', names: { '#v': 'version' }, values: { ':v': cur.version ?? 0 }, reason: 'retry' }
    : { condition: 'attribute_not_exists(PK)', reason: 'retry' });
  tx.put({
    ...keys.ledger(aid, uid, newId(now)), aid, uid, at: now, delta, type, reason, iid,
    by: actor.uid, byName: actor.name, balanceAfter: row.balance, availableAfter: row.available,
  });
  return row;
}

// ── Auctions and items ────────────────────────────────────────────────

export async function createAuction(user, body, now = Date.now()) {
  if (!user) throw unauthorized();
  let base = DEFAULT_RULES;
  if (body.templateId != null) {
    const template = await get(keys.template(user.uid, str(body.templateId, 'templateId', { min: 1, max: 64 })));
    if (!template) throw notFound('Template not found');
    base = mergeRules(DEFAULT_RULES, template.rules);
  }
  const rules = validateRules(mergeRules(base, body.rules ?? {}));
  const aid = randomUUID();
  const meta = {
    ...keys.auction(aid), aid,
    hostId: user.uid,
    hostName: user.name,
    title: str(body.title, 'title', { min: 1, max: 120 }),
    description: str(body.description, 'description', { max: 5000 }),
    status: 'draft',
    rules,
    itemCount: 0,
    openItems: 0,
    paddleSeq: 0,
    createdAt: now,
    updatedAt: now,
    GSI2PK: `HOST#${user.uid}`,
    GSI2SK: iso(now),
  };
  const tx = new Tx().put(meta, { condition: 'attribute_not_exists(PK)' });
  log(tx, aid, actorOf(user), 'auction.created', { title: meta.title }, now);
  await tx.run();
  return meta;
}

/** Title, description and rules. Timing and format are locked once live. */
export async function updateAuction(ctx, body, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  if (meta.status === 'ended') throw conflict('auction_ended', 'This auction has ended');
  const patch = {};
  if (body.title !== undefined) patch.title = str(body.title, 'title', { min: 1, max: 120 });
  if (body.description !== undefined) patch.description = str(body.description, 'description', { max: 5000 });
  let changed = [];
  if (body.rules !== undefined) {
    if (meta.status === 'live' && (body.rules.timing !== undefined || body.rules.format !== undefined)) {
      throw conflict('locked', 'Timing and format cannot change once the auction is live');
    }
    patch.rules = validateRules(mergeRules(meta.rules, body.rules));
    changed = diffPaths(meta.rules, patch.rules).map((p) => `rules.${p}`);
  }
  for (const k of ['title', 'description']) if (patch[k] !== undefined && patch[k] !== meta[k]) changed.push(k);
  if (!changed.length) return meta;

  const tx = new Tx();
  const names = { '#u': 'updatedAt' };
  const values = { ':now': now, ':u': meta.updatedAt };
  const set = ['#u = :now'];
  for (const [k, v] of Object.entries(patch)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    set.push(`#${k} = :${k}`);
  }
  tx.update(keys.auction(meta.aid), { set, names, values, condition: '#u = :u', reason: 'retry' });
  log(tx, meta.aid, actorOf(ctx.user), 'auction.updated', { changed }, now);
  try {
    await tx.run();
  } catch (err) {
    if (err instanceof TxConflict) throw conflict('stale', 'The auction changed meanwhile. Reload and try again.');
    throw err;
  }
  const next = { ...meta, ...patch, updatedAt: now };
  if (patch.rules && meta.status === 'live') {
    if (listed(patch.rules) !== listed(meta.rules)) {
      await update({
        Key: keys.auction(meta.aid),
        UpdateExpression: listed(patch.rules) ? 'SET GSI1PK = :g, GSI1SK = :gs' : 'REMOVE GSI1PK, GSI1SK',
        ExpressionAttributeValues: listed(patch.rules) ? { ':g': 'AUC#live', ':gs': iso(meta.createdAt) } : undefined,
      });
    }
    await refreshOpenStates(next);
  }
  return next;
}

/** After a rules change, recompute derived fields (next minimum, reserve) on open items. */
async function refreshOpenStates(meta) {
  const items = await query(`AUC#${meta.aid}`, 'ITEM#');
  const states = await batchGet(items.map((i) => keys.state(i.iid)));
  for (const item of items) {
    const s = states.get(`ITEM#${item.iid}|STATE`);
    if (!s || s.status !== 'open') continue;
    const rules = effectiveRules(meta.rules, item.overrides);
    const next = {
      ...s,
      nextMin: nextMin(s, rules),
      hasReserve: rules.price.reserve != null,
      reserveMet: rules.price.reserve == null || (s.leaderId != null
        && (rules.format === 'reverse' ? s.price <= rules.price.reserve : s.price >= rules.price.reserve)),
    };
    if (next.nextMin === s.nextMin && next.hasReserve === s.hasReserve && next.reserveMet === s.reserveMet) continue;
    const tx = new Tx();
    putState(tx, item.iid, meta.aid, s, next);
    await tx.run().catch((err) => { if (!(err instanceof TxConflict)) throw err; }); // a bid already recomputed it
  }
}

export function itemFields(body, rules, existing = {}) {
  const out = {};
  if (body.title !== undefined || !existing.title) out.title = str(body.title, 'title', { min: 1, max: 120 });
  if (body.description !== undefined) out.description = str(body.description, 'description', { max: 5000 });
  if (body.lot !== undefined) out.lot = str(body.lot, 'lot', { max: 20 });
  if (body.fields !== undefined) {
    if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields) || Object.keys(body.fields).length > 30) {
      throw badRequest('invalid', 'fields must be an object with up to 30 entries', { field: 'fields' });
    }
    out.fields = Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [
      str(k, 'field name', { min: 1, max: 40 }), str(String(v ?? ''), `fields.${k}`, { max: 500 }),
    ]));
  }
  if (body.media !== undefined) {
    if (!Array.isArray(body.media) || body.media.length > 20) {
      throw badRequest('invalid', 'media must be a list of up to 20 media keys', { field: 'media' });
    }
    out.media = body.media.map((m, i) => {
      const key = str(m, `media[${i}]`, { min: 1, max: 300 });
      if (!/^media\/[\w\-./]+$/.test(key) || key.includes('..')) throw badRequest('invalid', `media[${i}] must be a media/ key`);
      return key;
    });
  }
  if (body.overrides !== undefined) out.overrides = validateOverrides(rules, body.overrides);
  return out;
}

/** Opening state for an item, from its effective rules. */
export function openingState(rules, index, now) {
  const opensAt = rules.timing.opensAt ? Date.parse(rules.timing.opensAt) : now;
  if (!rules.timing.closesAt) throw conflict('no_close_time', 'Set timing.closesAt (on the auction or the item) first');
  const closesAt = Date.parse(rules.timing.closesAt) + index * rules.timing.staggerSec * 1000;
  if (closesAt < now + 60_000) throw conflict('close_time_passed', 'The close time must be at least a minute from now');
  return initialState(rules, { opensAt: Math.max(opensAt, 0), closesAt });
}

export async function createItem(ctx, body, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  if (meta.status === 'ended') throw conflict('auction_ended', 'This auction has ended');
  const iid = randomUUID();
  const item = { ...keys.item(meta.aid, iid), iid, aid: meta.aid, createdAt: now, ...itemFields(body, meta.rules) };
  const tx = new Tx().put(item, { condition: 'attribute_not_exists(PK)' });
  const counts = ['itemCount :one'];
  let opened = null;
  if (meta.status === 'live') {
    // Added to a live auction: open right away, closing after the existing items.
    const rules = effectiveRules(meta.rules, item.overrides);
    const index = item.overrides?.timing?.closesAt ? 0 : meta.itemCount;
    opened = stateRow(iid, meta.aid, { ...openingState(rules, index, now), version: 1 });
    tx.put(opened, { condition: 'attribute_not_exists(PK)' });
    counts.push('openItems :one');
  }
  tx.update(keys.auction(meta.aid), { add: counts, values: { ':one': 1 } });
  log(tx, meta.aid, actorOf(ctx.user), 'item.created', { target: iid, title: item.title }, now);
  await tx.run();
  if (opened) await scheduleClose(iid, opened.closesAt);
  return item;
}

export async function updateItem(ctx, iid, body, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  const [item, state] = await Promise.all([get(keys.item(meta.aid, iid)), get(keys.state(iid))]);
  if (!item) throw notFound('Item not found');
  if (state && state.status !== 'open' && body.overrides !== undefined) throw conflict('item_closed', 'This item has closed');
  if (state && (body.overrides?.timing !== undefined || (body.overrides?.format ?? item.overrides?.format) !== item.overrides?.format)) {
    throw conflict('locked', 'An open item keeps its timing and format');
  }
  const patch = itemFields(body, meta.rules, item);
  const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(item[k]));
  if (!changed.length) return item;
  const next = { ...item, ...patch, updatedAt: now };
  const tx = new Tx().put(next, {
    condition: 'attribute_not_exists(updatedAt) OR updatedAt = :u', values: { ':u': item.updatedAt ?? 0 }, reason: 'stale',
  });
  log(tx, meta.aid, actorOf(ctx.user), 'item.updated', { target: iid, changed }, now);
  await tx.run();
  if (state?.status === 'open' && patch.overrides !== undefined) await refreshOpenStates(meta);
  return next;
}

/** Draft -> live: every item opens and gets a close timer. */
export async function publishAuction(ctx, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  if (meta.status !== 'draft') throw conflict('not_draft', 'Only a draft can be published');
  const items = (await query(`AUC#${meta.aid}`, 'ITEM#', { consistent: true })).sort((a, b) => a.createdAt - b.createdAt);
  if (!items.length) throw conflict('no_items', 'Add at least one item first');
  let staggered = 0;
  const states = items.map((item) => {
    const rules = effectiveRules(meta.rules, item.overrides);
    const own = item.overrides?.timing?.closesAt != null;
    return stateRow(item.iid, meta.aid, { ...openingState(rules, own ? 0 : staggered++, now), version: 1 });
  });
  // One transaction holds 100 operations: META + log + up to 98 items.
  for (let i = 0; i < states.length; i += 98) {
    const tx = new Tx();
    for (const s of states.slice(i, i + 98)) tx.put(s, { condition: 'attribute_not_exists(PK)', reason: 'already_open' });
    if (i === 0) {
      const listing = listed(meta.rules);
      tx.update(keys.auction(meta.aid), {
        set: ['#s = :live', 'openItems = :n', 'publishedAt = :now', 'updatedAt = :now', ...(listing ? ['GSI1PK = :g', 'GSI1SK = :gs'] : [])],
        condition: '#s = :draft',
        names: { '#s': 'status' },
        values: { ':live': 'live', ':draft': 'draft', ':n': states.length, ':now': now, ...(listing ? { ':g': 'AUC#live', ':gs': iso(meta.createdAt) } : {}) },
        reason: 'not_draft',
      });
      log(tx, meta.aid, actorOf(ctx.user), 'auction.published', { items: states.length }, now);
    }
    await tx.run();
  }
  await Promise.all(states.map((s) => scheduleClose(s.iid, s.closesAt)));
  return { ...meta, status: 'live', openItems: states.length, publishedAt: now };
}

// ── Registrations ─────────────────────────────────────────────────────

/** The caller joins the auction. Approval depends on rules.registration. */
export async function register(ctx, body = {}, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const { meta, rules, user } = ctx;
  if (ctx.viewer.owner && !rules.conduct.hostCanBid) throw conflict('owner', 'You own this auction');
  if (meta.status !== 'live') throw conflict('auction_not_live', 'Registration opens when the auction is live');
  const existing = await get(keys.reg(meta.aid, user.uid));
  if (existing) return existing;
  if (rules.access.mode === 'code' && !ctx.viewer.owner) {
    const invited = rules.access.invites.some((e) => e.toLowerCase() === (user.email ?? '').toLowerCase());
    const given = Buffer.from(String(body.code ?? ''));
    const code = Buffer.from(rules.access.code ?? '');
    const codeOk = rules.access.code != null && given.length === code.length && timingSafeEqual(given, code);
    if (!invited && !codeOk) throw forbidden(body.code ? 'That access code is not right' : 'This auction needs an access code or an invite');
  }
  const { paddleSeq } = await update({
    Key: keys.auction(meta.aid), UpdateExpression: 'ADD paddleSeq :one', ExpressionAttributeValues: { ':one': 1 },
  });
  const status = rules.registration === 'auto' ? 'approved' : 'pending';
  const reg = {
    ...keys.reg(meta.aid, user.uid), aid: meta.aid, uid: user.uid,
    name: user.name, email: user.email,
    alias: str(body.alias, 'alias', { min: 2, max: 24, optional: true }) ?? `Bidder ${paddleSeq}`,
    paddle: paddleSeq,
    status,
    groups: [],
    see: {},
    bidLimit: null,
    muted: false,
    credited: false,
    createdAt: now,
    updatedAt: now,
    GSI2PK: `MEMBER#${user.uid}`,
    GSI2SK: iso(now),
  };
  const tx = new Tx();
  if (status === 'approved') startingCredit(tx, reg, rules, null, now);
  tx.put(reg, { condition: 'attribute_not_exists(PK)', reason: 'retry' });
  log(tx, meta.aid, actorOf(user), 'registration.created', { target: user.uid, status }, now);
  try {
    await tx.run();
  } catch (err) {
    if (err instanceof TxConflict) return get(keys.reg(meta.aid, user.uid)); // double click
    throw err;
  }
  return reg;
}

function startingCredit(tx, reg, rules, bal, now) {
  if (reg.credited || !rules.balance.enabled || rules.balance.startingCredit <= 0) return;
  credit(tx, reg.aid, reg.uid, bal, rules.balance.startingCredit, {
    type: 'credit', reason: 'Starting credit', actor: SYSTEM, now,
  });
  reg.credited = true;
}

/** Owner: approve/block, groups, per-field visibility overrides, bid limit, mute. */
export async function updateRegistration(ctx, uid, body, now = Date.now()) {
  requireOwner(ctx);
  const { meta, rules } = ctx;
  const reg = await get(keys.reg(meta.aid, uid));
  if (!reg) throw notFound('Registration not found');
  const next = { ...reg, updatedAt: now };
  if (body.status !== undefined) next.status = oneOf(body.status, 'status', ['pending', 'approved', 'blocked']);
  if (body.alias !== undefined) next.alias = str(body.alias, 'alias', { min: 2, max: 24 });
  if (body.note !== undefined) next.note = str(body.note, 'note', { max: 200 });
  if (body.muted !== undefined) next.muted = bool(body.muted, 'muted');
  if (body.bidLimit !== undefined) next.bidLimit = body.bidLimit === null ? null : int(body.bidLimit, 'bidLimit', { min: 1, max: MAX_AMOUNT });
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups) || body.groups.length > 10 || body.groups.some((g) => typeof g !== 'string' || !/^[a-z0-9-]{1,24}$/.test(g))) {
      throw badRequest('invalid', 'groups must be up to 10 names of a-z, 0-9 and -', { field: 'groups' });
    }
    next.groups = [...new Set(body.groups)];
  }
  if (body.see !== undefined) {
    if (!body.see || typeof body.see !== 'object' || Array.isArray(body.see)) throw badRequest('invalid', 'see must be an object', { field: 'see' });
    const see = { ...reg.see };
    for (const [field, v] of Object.entries(body.see)) {
      if (!(field in DEFAULT_RULES.visibility)) throw badRequest('invalid', `see.${field}: unknown field`, { field: `see.${field}` });
      if (v === null) delete see[field];
      else see[field] = bool(v, `see.${field}`);
    }
    next.see = see;
  }
  const changed = diffPaths(reg, next).filter((p) => p !== 'updatedAt');
  if (!changed.length) return reg;
  return withRetry(async () => {
    const tx = new Tx();
    if (next.status === 'approved') startingCredit(tx, next, rules, await get(keys.balance(meta.aid, uid)), now);
    tx.put(next, { condition: 'updatedAt = :u', values: { ':u': reg.updatedAt }, reason: 'stale' });
    log(tx, meta.aid, actorOf(ctx.user), 'registration.updated', { target: uid, changed, status: next.status }, now);
    await tx.run();
    return next;
  });
}

// ── Bids ──────────────────────────────────────────────────────────────

async function loadBidding(meta, iid, uid) {
  const found = await batchGet([keys.item(meta.aid, iid), keys.state(iid), keys.balance(meta.aid, uid)]);
  const item = found.get(`AUC#${meta.aid}|ITEM#${iid}`);
  const state = found.get(`ITEM#${iid}|STATE`);
  if (!item) throw notFound('Item not found');
  if (!state) throw conflict('item_not_open', 'This item is not open for bidding');
  return { item, state, bal: found.get(`AUC#${meta.aid}|BAL#${uid}`), rules: effectiveRules(meta.rules, item.overrides) };
}

function checkLimit(rules, reg, M) {
  const limit = reg.bidLimit ?? rules.limits.bidLimit;
  if (limit != null && M > limit) throw conflict('over_bid_limit', `Your bid limit here is ${limit}`, { bidLimit: limit });
}

/** The caller's approved registration (auto-registering where allowed), or a clear refusal. */
async function bidderReg(ctx, now) {
  if (ctx.viewer.owner && !ctx.rules.conduct.hostCanBid) throw forbidden('Hosts cannot bid in their own auction');
  let reg = ctx.viewer.reg;
  if (!reg) reg = await register(ctx, {}, now);
  if (reg.status === 'pending') throw forbidden('Your registration is waiting for the owner to approve it');
  if (reg.status !== 'approved') throw forbidden('This bidder cannot bid in this auction');
  return reg;
}

/** "My bids" pointer, overwritten on each bid. */
function touchBidOn(tx, uid, aid, iid, now) {
  tx.put({ ...keys.bidOn(uid, iid), uid, aid, iid, lastAt: now });
}

/**
 * Charges a buyer: what was held for them is released and the price taken,
 * as one ledger row. Returns the amount charged (0 when balances are off).
 */
function charge(tx, aid, uid, price, held, rules, { now, iid, via }) {
  if (!rules.balance.enabled) return 0;
  const enforce = rules.balance.enforce && price > held;
  tx.update(keys.balance(aid, uid), {
    set: [
      'committed = if_not_exists(committed, :z) - :h',
      'balance = if_not_exists(balance, :z) - :p',
      'available = if_not_exists(available, :z) + :net',
      '#v = if_not_exists(#v, :z) + :one',
      'uid = :uid', 'aid = :aid', 'updatedAt = :now',
    ],
    condition: enforce ? 'available >= :extra' : undefined,
    names: { '#v': 'version' },
    values: {
      ':z': 0, ':h': held, ':p': price, ':net': held - price, ':one': 1, ':uid': uid, ':aid': aid, ':now': now,
      ...(enforce ? { ':extra': price - held } : {}),
    },
    reason: 'insufficient_balance',
  });
  const reason = { auction: 'Won item', buy_now: 'Bought now', offer: 'Offer accepted' }[via];
  tx.put({
    ...keys.ledger(aid, uid, newId(now)), aid, uid, at: now, delta: -price, type: 'charge', reason, iid,
    by: SYSTEM.uid, byName: SYSTEM.name,
  });
  return price;
}

/**
 * Closes an item inside tx: final state, result row, the buyer's charge,
 * release of the english leader's hold if someone else bought, counters and
 * the audit row. sale = { winnerId, winnerTag, price, via, winnerHold }.
 */
function closeTx(tx, meta, rules, iid, state, outcome, sale, now, actor = SYSTEM) {
  const sold = outcome === 'sold';
  const next = { ...state, status: 'closed', closedAt: now, leaderHold: 0 };
  if (sold) Object.assign(next, { leaderId: sale.winnerId, leaderTag: sale.winnerTag, price: sale.price });
  putState(tx, iid, meta.aid, state, next);
  const result = {
    ...keys.result(iid), iid, aid: meta.aid, outcome, at: now,
    via: sold ? sale.via : null,
    winnerId: sold ? sale.winnerId : null,
    winnerTag: sold ? sale.winnerTag : null,
    price: sold ? sale.price : null,
    currency: rules.price.currency,
    payment: { status: 'unpaid' },
    fulfillment: { status: 'pending' },
    charged: 0,
  };
  const leaderHold = state.leaderHold ?? 0;
  const winnerLeads = sold && state.leaderId === sale.winnerId;
  if (state.leaderId && leaderHold > 0 && !winnerLeads) hold(tx, meta.aid, state.leaderId, -leaderHold, { now });
  if (sold && rules.format !== 'reverse') {
    const held = (winnerLeads ? leaderHold : 0) + (sale.winnerHold ?? 0);
    result.charged = charge(tx, meta.aid, sale.winnerId, sale.price, held, rules, { now, iid, via: sale.via });
  }
  tx.put(result, { condition: 'attribute_not_exists(PK)', reason: 'retry' });
  tx.update(keys.auction(meta.aid), { add: ['openItems :minus'], values: { ':minus': -1 } });
  log(tx, meta.aid, actor, 'item.closed', { iid, outcome, via: result.via, price: result.price, winner: result.winnerId }, now);
  return result;
}

/** Last open item closed: the auction has ended. */
export async function endIfDone(aid, now) {
  await update({
    Key: keys.auction(aid),
    UpdateExpression: 'SET #s = :ended, endedAt = :now REMOVE GSI1PK, GSI1SK',
    ConditionExpression: '#s = :live AND openItems <= :z',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':ended': 'ended', ':live': 'live', ':z': 0, ':now': now },
  }).catch((err) => { if (err.name !== 'ConditionalCheckFailedException') throw err; });
}

/**
 * Applies an accepted bid to tx, for every format:
 *   english/reverse  new leader, price, holds
 *   sealed           the bidder's one hidden bid (replacing any earlier one) and its hold
 *   dutch            the first acceptance buys the item at the current price
 */
async function acceptInto(tx, { meta, rules, iid, state, bal, reg, bid, bidId, now, placedAt, approving }) {
  const enforce = rules.balance.enabled && rules.balance.enforce;
  if (isSealed(rules)) {
    const prev = await get(keys.sealed(iid, bid.uid));
    const newHold = rules.balance.enabled ? bid.amount : 0;
    const delta = newHold - (prev?.held ? prev.hold : 0);
    checkFunds(rules, bal, delta);
    const { state: next, outcome } = evaluateBid(state, rules, { ...bid, replacing: !!prev }, now, { placedAt, approving });
    putState(tx, iid, meta.aid, state, next);
    tx.put({
      ...keys.sealed(iid, bid.uid), aid: meta.aid, iid, uid: bid.uid, tag: tagOf(reg),
      amount: bid.amount, bidId, placedAt, hold: newHold, held: newHold > 0,
    });
    hold(tx, meta.aid, bid.uid, delta, { enforce, now });
    return { outcome };
  }
  const { state: next, outcome } = evaluateBid(state, rules, bid, now, { placedAt, approving });
  if (rules.format === 'dutch') {
    checkFunds(rules, bal, next.price);
    closeTx(tx, meta, rules, iid, state, 'sold', { winnerId: bid.uid, winnerTag: tagOf(reg), price: next.price, via: 'auction' }, now);
    return { outcome, sold: true, price: next.price };
  }
  const leading = state.leaderId === bid.uid;
  checkFunds(rules, bal, Math.max(bid.amount, bid.max ?? bid.amount) - (leading ? state.leaderHold ?? 0 : 0));
  if (next.leaderId !== state.leaderId) next.leaderTag = tagOf(reg);
  moveHolds(tx, meta.aid, state, next, rules, now);
  putState(tx, iid, meta.aid, state, next);
  return { outcome };
}

/** The funds a bid would need now, for the pending-bid check. */
function fundsNeeded(rules, state, bid, sealedRow) {
  if (isSealed(rules)) return bid.amount - (sealedRow?.held ? sealedRow.hold : 0);
  const M = Math.max(bid.amount, bid.max ?? bid.amount);
  return M - (state.leaderId === bid.uid ? state.leaderHold ?? 0 : 0);
}

/**
 * A bid from the caller, or (owner only) entered for a bidder with
 * onBehalfOf. Depending on the rules it is accepted now or waits for the
 * owner's approval.
 */
export async function placeBid(ctx, iid, body, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const { meta } = ctx;
  if (meta.status !== 'live') throw conflict('auction_not_live', 'This auction is not live');
  const amount = int(body.amount, 'amount', { min: 1, max: MAX_AMOUNT });
  const max = int(body.max, 'max', { min: 1, max: MAX_AMOUNT, optional: true });
  const confirmed = body.confirmed === true;
  const onBehalf = body.onBehalfOf != null;
  if (onBehalf && !ctx.viewer.owner) throw forbidden('Only the owner can bid for someone else');

  let uid;
  let reg;
  if (onBehalf) {
    uid = str(body.onBehalfOf, 'onBehalfOf', { min: 1, max: 64 });
    reg = await get(keys.reg(meta.aid, uid));
    if (!reg) throw notFound('That bidder is not registered in this auction');
    if (reg.status !== 'approved') throw forbidden('This bidder cannot bid in this auction');
  } else {
    uid = ctx.user.uid;
    reg = await bidderReg(ctx, now);
  }

  return withRetry(async () => {
    const { state, bal, rules } = await loadBidding(meta, iid, uid);
    const bid = { uid, amount, max, confirmed };
    checkLimit(rules, reg, Math.max(amount, max ?? amount));
    const bidId = newId(now);
    const base = {
      ...keys.bid(iid, bidId), bidId, iid, aid: meta.aid, uid, tag: tagOf(reg),
      amount, max, placedAt: now, kind: onBehalf ? 'on_behalf' : 'bid',
      enteredBy: onBehalf ? ctx.user.uid : undefined,
    };

    if (needsApproval(rules, bid, { onBehalf })) {
      if (rules.bidApproval.mode === 'all' && max != null && max > amount) {
        throw new RuleError('proxy_disabled', 'Maximum bids are off while every bid needs approval');
      }
      const sealedRow = isSealed(rules) ? await get(keys.sealed(iid, uid)) : null;
      evaluateBid(state, rules, { ...bid, replacing: !!sealedRow }, now); // must be valid now; applied only when approved
      checkFunds(rules, bal, fundsNeeded(rules, state, bid, sealedRow));
      const tx = new Tx();
      tx.put({ ...base, status: 'pending' });
      tx.put({ ...keys.pending(meta.aid, bidId), aid: meta.aid, iid, bidId, uid, at: now });
      touchBidOn(tx, uid, meta.aid, iid, now);
      tx.update(keys.state(iid), {
        set: ['#v = #v + :one'], add: ['pendingCount :one'],
        condition: '#v = :v AND #s = :open',
        names: { '#v': 'version', '#s': 'status' },
        values: { ':one': 1, ':v': state.version, ':open': 'open' },
        reason: 'retry',
      });
      await tx.run();
      return { status: 'pending', bidId };
    }

    const tx = new Tx();
    const out = await acceptInto(tx, { meta, rules, iid, state, bal, reg, bid, bidId, now, placedAt: now, approving: false });
    tx.put({ ...base, status: 'accepted', acceptedAt: now, ...(out.sold ? { amount: out.price, offered: amount } : {}) });
    touchBidOn(tx, uid, meta.aid, iid, now);
    if (onBehalf) log(tx, meta.aid, actorOf(ctx.user), 'bid.entered', { target: uid, iid, bidId, amount, max }, now);
    await tx.run();
    if (out.sold) await endIfDone(meta.aid, now);
    return { status: 'accepted', outcome: out.outcome, bidId, ...(out.sold ? { price: out.price } : {}) };
  });
}

/**
 * Owner approves or rejects a pending bid. Approving may change the amount
 * if rules.bidApproval.adjust allows it (lower = only down, any = either way).
 */
export async function decideBid(ctx, iid, bidId, body, now = Date.now()) {
  requireOwner(ctx);
  const approve = bool(body.approve, 'approve');
  const amount = int(body.amount, 'amount', { min: 1, max: MAX_AMOUNT, optional: true });
  const reason = str(body.reason, 'reason', { max: 200, optional: true });
  return decide({ meta: ctx.meta, actor: actorOf(ctx.user), iid, bidId, approve, amount, reason, now });
}

async function decide({ meta, actor, iid, bidId, approve, amount, reason, now }) {
  return withRetry(async () => {
    const bid = await get(keys.bid(iid, bidId));
    if (!bid || bid.aid !== meta.aid) throw notFound('Bid not found');
    if (bid.status !== 'pending') throw conflict('already_decided', `This bid was already ${bid.status}`);
    const { state, bal, rules } = await loadBidding(meta, iid, bid.uid);
    const tx = new Tx();

    if (!approve) {
      tx.update(keys.bid(iid, bidId), {
        set: ['#s = :to', 'decidedAt = :now', 'decidedBy = :by', ...(reason ? ['reason = :r'] : [])],
        condition: '#s = :pending',
        names: { '#s': 'status' },
        values: { ':to': 'rejected', ':now': now, ':by': actor.uid, ':pending': 'pending', ...(reason ? { ':r': reason } : {}) },
        reason: 'retry',
      });
      tx.delete(keys.pending(meta.aid, bidId));
      tx.update(keys.state(iid), {
        set: ['#v = #v + :one'], add: ['pendingCount :minus'],
        condition: '#v = :v', names: { '#v': 'version' },
        values: { ':one': 1, ':minus': -1, ':v': state.version }, reason: 'retry',
      });
      log(tx, meta.aid, actor, 'bid.rejected', { target: bid.uid, iid, bidId, amount: bid.amount, reason }, now);
      await tx.run();
      return { status: 'rejected', bidId };
    }

    let finalAmount = bid.amount;
    if (amount != null && amount !== bid.amount) {
      const adjust = rules.bidApproval.adjust;
      if (adjust === 'none' || (adjust === 'lower' && amount > bid.amount)) {
        throw forbidden(adjust === 'none' ? 'The rules do not let the owner change bid amounts' : 'The rules only let the owner lower a bid');
      }
      finalAmount = amount;
    }
    const max = bid.max != null && bid.max >= finalAmount ? bid.max : undefined;
    const reg = await get(keys.reg(meta.aid, bid.uid));
    if (!reg || reg.status !== 'approved') throw conflict('bidder_not_approved', 'This bidder is no longer approved; reject the bid instead');
    checkLimit(rules, reg, Math.max(finalAmount, max ?? finalAmount));
    const base = { ...state, pendingCount: Math.max(0, (state.pendingCount ?? 1) - 1) };
    const out = await acceptInto(tx, {
      meta, rules, iid, state: base, bal, reg, bidId, now, placedAt: bid.placedAt, approving: true,
      bid: { uid: bid.uid, amount: finalAmount, max, confirmed: true },
    });
    tx.update(keys.bid(iid, bidId), {
      set: ['#s = :accepted', 'amount = :amount', 'acceptedAt = :now', 'decidedAt = :now', 'decidedBy = :by',
        ...(max === undefined ? ['#max = :null'] : []),
        ...(finalAmount !== bid.amount ? ['originalAmount = :orig'] : []),
        ...(reason ? ['reason = :r'] : [])],
      condition: '#s = :pending',
      names: { '#s': 'status', ...(max === undefined ? { '#max': 'max' } : {}) },
      values: {
        ':accepted': 'accepted', ':pending': 'pending', ':amount': finalAmount, ':now': now, ':by': actor.uid,
        ...(max === undefined ? { ':null': null } : {}),
        ...(finalAmount !== bid.amount ? { ':orig': bid.amount } : {}),
        ...(reason ? { ':r': reason } : {}),
      },
      reason: 'retry',
    });
    tx.delete(keys.pending(meta.aid, bidId));
    log(tx, meta.aid, actor, 'bid.approved', { target: bid.uid, iid, bidId, amount: finalAmount, originalAmount: bid.amount, reason }, now);
    await tx.run();
    return { status: 'accepted', outcome: out.outcome, bidId };
  });
}

/** Bidder takes back their own pending bid. */
export async function withdrawBid(ctx, iid, bidId, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  return withRetry(async () => {
    const [bid, state] = await Promise.all([get(keys.bid(iid, bidId)), get(keys.state(iid))]);
    if (!bid || bid.aid !== ctx.meta.aid || bid.uid !== ctx.user.uid) throw notFound('Bid not found');
    if (bid.status !== 'pending') throw conflict('not_pending', 'Only a bid waiting for approval can be withdrawn');
    const tx = new Tx();
    tx.update(keys.bid(iid, bidId), {
      set: ['#s = :w', 'decidedAt = :now'], condition: '#s = :p',
      names: { '#s': 'status' }, values: { ':w': 'withdrawn', ':p': 'pending', ':now': now }, reason: 'retry',
    });
    tx.delete(keys.pending(ctx.meta.aid, bidId));
    tx.update(keys.state(iid), {
      set: ['#v = #v + :one'], add: ['pendingCount :minus'], condition: '#v = :v',
      names: { '#v': 'version' }, values: { ':one': 1, ':minus': -1, ':v': state.version }, reason: 'retry',
    });
    await tx.run();
    return { status: 'withdrawn', bidId };
  });
}

/** Owner voids an accepted bid; price and leader are rebuilt from the rest. */
export async function cancelBid(ctx, iid, bidId, body, now = Date.now()) {
  requireOwner(ctx);
  const reason = str(body.reason, 'reason', { min: 1, max: 200 });
  const { meta } = ctx;
  return withRetry(async () => {
    const [item, state, bids] = await Promise.all([
      get(keys.item(meta.aid, iid)), get(keys.state(iid)), query(`ITEM#${iid}`, 'BID#', { consistent: true }),
    ]);
    if (!item || !state) throw notFound('Item not found');
    if (state.status !== 'open') throw conflict('item_closed', 'Bids on a closed item cannot be cancelled');
    const bid = bids.find((b) => b.bidId === bidId);
    if (!bid) throw notFound('Bid not found');
    if (bid.status !== 'accepted') throw conflict('not_accepted', `This bid is ${bid.status}`);
    const rules = effectiveRules(meta.rules, item.overrides);
    const tx = new Tx();
    if (isSealed(rules)) {
      // Only the bidder's current sealed bid counts; an older one was already replaced.
      const current = await get(keys.sealed(iid, bid.uid));
      if (current?.bidId === bidId) {
        tx.delete(keys.sealed(iid, bid.uid), { condition: 'bidId = :b', values: { ':b': bidId }, reason: 'retry' });
        if (current.held) hold(tx, meta.aid, bid.uid, -current.hold, { now });
        putState(tx, iid, meta.aid, state, { ...state, bidCount: Math.max(0, state.bidCount - 1) });
      }
    } else {
      const rest = bids.filter((b) => b.status === 'accepted' && b.bidId !== bidId);
      const next = replay(state, rules, rest);
      next.leaderTag = next.leaderId ? rest.filter((b) => b.uid === next.leaderId).at(-1).tag : null;
      moveHolds(tx, meta.aid, state, next, { ...rules, balance: { ...rules.balance, enforce: false } }, now);
      putState(tx, iid, meta.aid, state, next);
    }
    tx.update(keys.bid(iid, bidId), {
      set: ['#s = :c', 'decidedAt = :now', 'decidedBy = :by', 'reason = :r'], condition: '#s = :a',
      names: { '#s': 'status' },
      values: { ':c': 'cancelled', ':a': 'accepted', ':now': now, ':by': ctx.user.uid, ':r': reason }, reason: 'retry',
    });
    log(tx, meta.aid, actorOf(ctx.user), 'bid.cancelled', { target: bid.uid, iid, bidId, amount: bid.amount, reason }, now);
    await tx.run();
    return { status: 'cancelled', bidId };
  });
}

/** Rejects bids still pending on an item that just sold outright. */
async function rejectLeftovers(meta, iid, reason, now) {
  const pending = (await query(`ITEM#${iid}`, 'BID#', { consistent: true })).filter((b) => b.status === 'pending');
  for (const b of pending) {
    const tx = new Tx();
    tx.update(keys.bid(iid, b.bidId), {
      set: ['#s = :r', 'decidedAt = :now', 'decidedBy = :by', 'reason = :why'], condition: '#s = :p',
      names: { '#s': 'status' }, values: { ':r': 'rejected', ':p': 'pending', ':now': now, ':by': SYSTEM.uid, ':why': reason },
    });
    tx.delete(keys.pending(meta.aid, b.bidId));
    await tx.run().catch((err) => { if (!(err instanceof TxConflict)) throw err; });
  }
}

// ── Buy It Now and offers ─────────────────────────────────────────────

/** english with price.buyNow, or a fixed_price listing: buy outright and close the item. */
export async function buyNow(ctx, iid, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const { meta } = ctx;
  if (meta.status !== 'live') throw conflict('auction_not_live', 'This auction is not live');
  const reg = await bidderReg(ctx, now);
  const uid = ctx.user.uid;
  const out = await withRetry(async () => {
    const { state, bal, rules } = await loadBidding(meta, iid, uid);
    const price = buyNowPrice(state, rules);
    if (price == null) throw conflict('buy_now_unavailable', 'Buying outright is not available for this item');
    if (now < state.opensAt || now >= state.closesAt) throw conflict('item_closed', 'This item is not open');
    checkLimit(rules, reg, price);
    checkFunds(rules, bal, price - (state.leaderId === uid ? state.leaderHold ?? 0 : 0));
    const bidId = newId(now);
    const tx = new Tx();
    tx.put({
      ...keys.bid(iid, bidId), bidId, iid, aid: meta.aid, uid, tag: tagOf(reg), amount: price,
      placedAt: now, acceptedAt: now, kind: 'buy_now', status: 'accepted',
    });
    touchBidOn(tx, uid, meta.aid, iid, now);
    closeTx(tx, meta, rules, iid, state, 'sold', { winnerId: uid, winnerTag: tagOf(reg), price, via: 'buy_now' }, now, actorOf(ctx.user));
    await tx.run();
    return { status: 'sold', price, bidId, hadPending: (state.pendingCount ?? 0) > 0 };
  });
  if (out.hadPending) await rejectLeftovers(meta, iid, 'Item sold with Buy It Now', now);
  await endIfDone(meta.aid, now);
  return { status: out.status, price: out.price, bidId: out.bidId };
}

const OPEN_OFFER = ['pending', 'countered'];

async function loadOffer(meta, iid, oid) {
  const offer = await get(keys.offer(iid, oid));
  if (!offer || offer.aid !== meta.aid) throw notFound('Offer not found');
  return offer;
}

/** Sells a fixed_price item on an agreed offer, inside tx. */
function sellOnOffer(tx, meta, rules, iid, state, bal, offer, price, now, actor) {
  if (state.status !== 'open') throw conflict('item_closed', 'This item is no longer for sale');
  checkFunds(rules, bal, price);
  closeTx(tx, meta, rules, iid, state, 'sold', { winnerId: offer.uid, winnerTag: offer.tag, price, via: 'offer' }, now, actor);
}

/** A buyer offers a price on a fixed_price listing. Thresholds may decide it at once. */
export async function makeOffer(ctx, iid, body, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const { meta } = ctx;
  if (meta.status !== 'live') throw conflict('auction_not_live', 'This auction is not live');
  const amount = int(body.amount, 'amount', { min: 1, max: MAX_AMOUNT });
  const message = str(body.message, 'message', { max: 300, optional: true });
  const reg = await bidderReg(ctx, now);
  const uid = ctx.user.uid;
  const out = await withRetry(async () => {
    const { state, bal, rules } = await loadBidding(meta, iid, uid);
    if (rules.format !== 'fixed_price' || !rules.price.offers.enabled) throw conflict('offers_disabled', 'This item does not take offers');
    if (state.status !== 'open' || now < state.opensAt || now >= state.closesAt) throw conflict('item_closed', 'This item is not open');
    const mine = (await query(`ITEM#${iid}`, 'OFFER#', { consistent: true })).filter((o) => o.uid === uid && OPEN_OFFER.includes(o.status));
    if (mine.length) throw conflict('offer_open', 'You already have an open offer on this item; withdraw it first');
    checkLimit(rules, reg, amount);
    const verdict = offerVerdict(rules, amount);
    const price = Math.min(amount, rules.price.start);
    checkFunds(rules, bal, verdict === 'decline' ? 0 : price);
    const oid = newId(now);
    const offer = {
      ...keys.offer(iid, oid), oid, iid, aid: meta.aid, uid, tag: tagOf(reg), amount, message, createdAt: now,
      status: { accept: 'accepted', decline: 'declined', pending: 'pending' }[verdict],
      ...(verdict !== 'pending' ? { decidedAt: now, decidedBy: SYSTEM.uid, auto: true } : {}),
    };
    const tx = new Tx();
    tx.put(offer);
    touchBidOn(tx, uid, meta.aid, iid, now);
    if (verdict === 'accept') sellOnOffer(tx, meta, rules, iid, state, bal, offer, price, now, SYSTEM);
    await tx.run();
    return { offer, sold: verdict === 'accept', price };
  });
  if (out.sold) await endIfDone(meta.aid, now);
  return out.offer;
}

/** Owner accepts, declines or counters a pending offer. */
export async function decideOffer(ctx, iid, oid, body, now = Date.now()) {
  requireOwner(ctx);
  const action = oneOf(body.action, 'action', ['accept', 'decline', 'counter']);
  const message = str(body.message, 'message', { max: 300, optional: true });
  const { meta } = ctx;
  const out = await withRetry(async () => {
    const offer = await loadOffer(meta, iid, oid);
    if (offer.status !== 'pending') throw conflict('offer_not_pending', `This offer is ${offer.status}`);
    const tx = new Tx();
    const guard = { condition: '#s = :pending', names: { '#s': 'status' }, reason: 'retry' };
    let sold = false;
    if (action === 'accept') {
      const { state, bal, rules } = await loadBidding(meta, iid, offer.uid);
      sellOnOffer(tx, meta, rules, iid, state, bal, offer, offer.amount, now, actorOf(ctx.user));
      sold = true;
      tx.update(keys.offer(iid, oid), { ...guard, set: ['#s = :to', 'decidedAt = :now', 'decidedBy = :by'], values: { ':to': 'accepted', ':pending': 'pending', ':now': now, ':by': ctx.user.uid } });
    } else if (action === 'decline') {
      tx.update(keys.offer(iid, oid), {
        ...guard, set: ['#s = :to', 'decidedAt = :now', 'decidedBy = :by', ...(message ? ['reply = :m'] : [])],
        values: { ':to': 'declined', ':pending': 'pending', ':now': now, ':by': ctx.user.uid, ...(message ? { ':m': message } : {}) },
      });
    } else {
      const counter = int(body.amount, 'amount', { min: offer.amount + 1, max: MAX_AMOUNT });
      tx.update(keys.offer(iid, oid), {
        ...guard, set: ['#s = :to', 'counterAmount = :c', 'decidedAt = :now', 'decidedBy = :by', ...(message ? ['reply = :m'] : [])],
        values: { ':to': 'countered', ':c': counter, ':pending': 'pending', ':now': now, ':by': ctx.user.uid, ...(message ? { ':m': message } : {}) },
      });
    }
    const verb = { accept: 'accepted', decline: 'declined', counter: 'countered' }[action];
    log(tx, meta.aid, actorOf(ctx.user), `offer.${verb}`, { target: offer.uid, iid, oid, amount: offer.amount, counter: body.amount }, now);
    await tx.run();
    return { sold };
  });
  if (out.sold) await endIfDone(meta.aid, now);
  return loadOffer(meta, iid, oid);
}

/** Buyer accepts or declines the owner's counter-offer. */
export async function respondOffer(ctx, iid, oid, body, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const accept = bool(body.accept, 'accept');
  const { meta } = ctx;
  const out = await withRetry(async () => {
    const offer = await loadOffer(meta, iid, oid);
    if (offer.uid !== ctx.user.uid) throw notFound('Offer not found');
    if (offer.status !== 'countered') throw conflict('no_counter', 'There is no counter-offer to answer');
    const tx = new Tx();
    if (accept) {
      const { state, bal, rules } = await loadBidding(meta, iid, offer.uid);
      sellOnOffer(tx, meta, rules, iid, state, bal, offer, offer.counterAmount, now, actorOf(ctx.user));
    }
    tx.update(keys.offer(iid, oid), {
      set: ['#s = :to', 'respondedAt = :now'], condition: '#s = :c', names: { '#s': 'status' },
      values: { ':to': accept ? 'accepted' : 'declined', ':c': 'countered', ':now': now }, reason: 'retry',
    });
    await tx.run();
    return { sold: accept };
  });
  if (out.sold) await endIfDone(meta.aid, now);
  return loadOffer(meta, iid, oid);
}

export async function withdrawOffer(ctx, iid, oid, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const offer = await loadOffer(ctx.meta, iid, oid);
  if (offer.uid !== ctx.user.uid) throw notFound('Offer not found');
  if (!OPEN_OFFER.includes(offer.status)) throw conflict('offer_closed', `This offer is ${offer.status}`);
  await new Tx().update(keys.offer(iid, oid), {
    set: ['#s = :w', 'respondedAt = :now'], condition: '#s IN (:p, :c)', names: { '#s': 'status' },
    values: { ':w': 'withdrawn', ':p': 'pending', ':c': 'countered', ':now': now }, reason: 'offer_closed',
  }).run();
  return { ...offer, status: 'withdrawn' };
}

/** Owner: every offer on the item. Buyer: their own. */
export async function listOffers(ctx, iid) {
  if (!ctx.user) throw unauthorized();
  const [offers, state] = await Promise.all([query(`ITEM#${iid}`, 'OFFER#', { desc: true }), get(keys.state(iid))]);
  const closed = state?.status !== 'open';
  return offers
    .filter((o) => ctx.viewer.owner || o.uid === ctx.user.uid)
    .map((o) => ({
      id: o.oid,
      buyer: ctx.viewer.owner ? { uid: o.uid, label: o.tag?.name ?? o.tag?.alias, alias: o.tag?.alias, paddle: o.tag?.paddle } : { you: true, label: 'You' },
      amount: o.amount,
      message: o.message ?? null,
      status: closed && OPEN_OFFER.includes(o.status) ? 'expired' : o.status,
      counterAmount: o.counterAmount ?? null,
      reply: o.reply ?? null,
      auto: !!o.auto,
      createdAt: o.createdAt,
      decidedAt: o.decidedAt ?? null,
    }));
}

// ── Closing ───────────────────────────────────────────────────────────

/**
 * Closes an item if it is due. Soft close may have moved closesAt; pending
 * bids get until closesAt + decideWithinSec, then onTimeout decides them.
 * reschedule=false (the cron sweep) never creates timers.
 */
export async function closeItem(iid, { now = Date.now(), reschedule = true } = {}) {
  for (let round = 0; round < 5; round += 1) {
    const state = await get(keys.state(iid));
    if (!state || state.status !== 'open') return { iid, result: 'not_open' };
    if (now < state.closesAt) {
      if (reschedule) await scheduleClose(iid, state.closesAt);
      return { iid, result: 'not_due', closesAt: state.closesAt };
    }
    const [meta, item] = await Promise.all([get(keys.auction(state.aid)), get(keys.item(state.aid, iid))]);
    const rules = effectiveRules(meta.rules, item?.overrides);

    if ((state.pendingCount ?? 0) > 0) {
      const deadline = state.closesAt + rules.bidApproval.decideWithinSec * 1000;
      if (now < deadline) {
        if (reschedule) await scheduleClose(iid, deadline);
        return { iid, result: 'waiting_for_decisions', deadline };
      }
      const pending = (await query(`ITEM#${iid}`, 'BID#', { consistent: true }))
        .filter((b) => b.status === 'pending').sort((a, b) => a.placedAt - b.placedAt);
      for (const bid of pending) {
        const approve = rules.bidApproval.onTimeout === 'approve';
        const reason = 'Not decided in time';
        try {
          await decide({ meta, actor: SYSTEM, iid, bidId: bid.bidId, approve, reason, now: Math.min(now, deadline) });
        } catch (err) {
          if (!approve || !(err instanceof RuleError || err.status === 409 || err.status === 403)) throw err;
          await decide({ meta, actor: SYSTEM, iid, bidId: bid.bidId, approve: false, reason: `${reason}; could not apply: ${err.message}`, now });
        }
      }
      continue; // re-read the state the decisions produced
    }

    try {
      return await finalize(meta, rules, iid, state, now);
    } catch (err) {
      if (err instanceof TxConflict && err.reason === 'retry') continue; // a late write raced us
      throw err;
    }
  }
  throw new Error(`closeItem ${iid}: state kept changing`);
}

/** Releases one losing sealed bid's hold. Safe to repeat. */
async function releaseSealed(aid, iid, row, now) {
  const tx = new Tx();
  tx.update(keys.sealed(iid, row.uid), { set: ['held = :f'], condition: 'held = :t', values: { ':f': false, ':t': true }, reason: 'done' });
  hold(tx, aid, row.uid, -row.hold, { now });
  await tx.run().catch((err) => { if (!(err instanceof TxConflict)) throw err; });
}

async function finalize(meta, rules, iid, state, now) {
  const tx = new Tx();
  let outcome;
  let result;
  if (isSealed(rules)) {
    const sealed = await query(`ITEM#${iid}`, 'SEALED#', { consistent: true });
    const res = sealedResult(rules, sealed);
    outcome = res.outcome;
    for (const row of sealed) if (row.held && row.uid !== res.winner?.uid) await releaseSealed(meta.aid, iid, row, now);
    const w = res.winner;
    result = closeTx(tx, meta, rules, iid, state, outcome,
      w ? { winnerId: w.uid, winnerTag: w.tag, price: res.price, via: 'auction', winnerHold: w.held ? w.hold : 0 } : null, now);
    if (w?.held) tx.update(keys.sealed(iid, w.uid), { set: ['held = :f'], values: { ':f': false } });
  } else {
    // dutch and fixed_price items that reach their close time were not bought.
    outcome = rules.format === 'dutch' || rules.format === 'fixed_price' ? 'no_bids' : closeOutcome(state);
    const sale = outcome === 'sold' ? { winnerId: state.leaderId, winnerTag: state.leaderTag, price: state.price, via: 'auction' } : null;
    result = closeTx(tx, meta, rules, iid, state, outcome, sale, now);
  }
  await tx.run();
  await endIfDone(meta.aid, now);
  return { iid, result: outcome, price: result.price };
}

/** Cron safety net: close every item whose time has passed. */
export async function sweepOverdue(now = Date.now()) {
  const due = await queryIndex('GSI1', 'STATUS#open', { desc: false, lte: iso(now), limit: 50 });
  const results = [];
  for (const s of due) {
    try {
      results.push(await closeItem(s.iid, { now, reschedule: false }));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'sweep close failed', iid: s.iid, error: String(err) }));
    }
  }
  return results;
}

// ── Chat ──────────────────────────────────────────────────────────────

export function canReadChat(ctx) {
  return ctx.viewer.owner || (ctx.rules.chat.enabled && allowed(ctx.viewer, ctx.rules.chat.read));
}

export async function postChat(ctx, body, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const { meta, rules, viewer } = ctx;
  const chat = rules.chat;
  if (meta.status === 'draft') throw conflict('auction_not_live', 'Chat opens when the auction is published');
  const text = str(body.text, 'text', { min: 1, max: chat.maxLength })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''); // control characters, newlines kept
  if (!text) throw badRequest('invalid', 'text is empty', { field: 'text' });
  const id = newId(now);
  const tx = new Tx();
  if (viewer.owner) {
    tx.put({ ...keys.chat(meta.aid, id), aid: meta.aid, id, uid: ctx.user.uid, role: 'host', tag: { alias: 'Host', name: ctx.user.name }, text, at: now });
  } else {
    if (!chat.enabled) throw forbidden('Chat is off for this auction');
    if (chat.hostOnly) throw forbidden('Only the host can post here');
    const reg = viewer.reg;
    if (!reg || !allowed(viewer, chat.post)) throw forbidden('You cannot post in this chat');
    if (reg.muted) throw forbidden('The host muted you in this chat');
    tx.put({ ...keys.chat(meta.aid, id), aid: meta.aid, id, uid: ctx.user.uid, role: 'bidder', tag: tagOf(reg), text, at: now });
    if (chat.slowModeSec > 0) {
      tx.update(keys.reg(meta.aid, ctx.user.uid), {
        set: ['lastChatAt = :now'],
        condition: 'attribute_not_exists(lastChatAt) OR lastChatAt <= :cutoff',
        values: { ':now': now, ':cutoff': now - chat.slowModeSec * 1000 },
        reason: 'slow_mode',
      });
    }
  }
  try {
    await tx.run();
  } catch (err) {
    if (err instanceof TxConflict && err.reason === 'slow_mode') {
      throw conflict('slow_mode', `Slow mode: one message every ${chat.slowModeSec} s`, { slowModeSec: chat.slowModeSec });
    }
    throw err;
  }
  return { id, uid: ctx.user.uid, role: viewer.owner ? 'host' : 'bidder', tag: viewer.owner ? { alias: 'Host', name: ctx.user.name } : tagOf(viewer.reg), text, at: now };
}

/** Newest `limit` messages, or everything after a message id (for catch-up after a live ping). */
export async function listChat(ctx, { after, limit = 50 } = {}) {
  if (!canReadChat(ctx)) throw forbidden('You cannot read this chat');
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (after) return query(`AUC#${ctx.meta.aid}`, 'CHAT#', { after, limit: n });
  return (await query(`AUC#${ctx.meta.aid}`, 'CHAT#', { desc: true, limit: n })).reverse();
}

/** The owner removes any message; authors remove their own. */
export async function deleteChat(ctx, id, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const msg = await get(keys.chat(ctx.meta.aid, id));
  if (!msg) throw notFound('Message not found');
  if (!ctx.viewer.owner && msg.uid !== ctx.user.uid) throw forbidden('You can only delete your own messages');
  const tx = new Tx();
  tx.update(keys.chat(ctx.meta.aid, id), {
    set: ['deleted = :t', 'deletedBy = :by', 'deletedAt = :now'], remove: ['#text'],
    names: { '#text': 'text' }, values: { ':t': true, ':by': ctx.user.uid, ':now': now },
  });
  if (ctx.viewer.owner && msg.uid !== ctx.user.uid) {
    log(tx, ctx.meta.aid, actorOf(ctx.user), 'chat.deleted', { target: msg.uid, messageId: id, text: msg.text }, now);
  }
  await tx.run();
  return { id, deleted: true };
}
