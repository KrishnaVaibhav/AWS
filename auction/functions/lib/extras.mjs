// Everything around the auction itself: watchlist and "my bids", templates,
// cloning, CSV import, deleting, analytics, invoices and payment status,
// media uploads, notifications and Web Push subscriptions.

import { randomUUID } from 'node:crypto';
import { keys, get, put, query, batchGet, update, deleteKeys, Tx, newId } from './db.mjs';
import { DEFAULT_RULES, mergeRules, validateRules, effectiveRules } from './rules.mjs';
import { badRequest, conflict, notFound, unauthorized, str, int, oneOf } from './http.mjs';
import { presignPost, scheduleClose } from './aws.mjs';
import { csvObjects } from './csv.mjs';
import {
  requireOwner, createAuction, log, stateRow, openingState, itemFields, actorOf,
} from './auction.mjs';
import { validEndpoint, vapidKeys } from './webpush.mjs';
import { pushHash } from './notify.mjs';

const MB = 1024 * 1024;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── Watchlist and "my bids" ───────────────────────────────────────────

export async function setWatch(ctx, iid, on, now = Date.now()) {
  if (!ctx.user) throw unauthorized();
  const item = await get(keys.item(ctx.meta.aid, iid));
  if (!item) throw notFound('Item not found');
  const uid = ctx.user.uid;
  const tx = new Tx();
  if (on) {
    tx.put({ ...keys.watch(uid, iid), uid, aid: ctx.meta.aid, iid, at: now });
    tx.put({ ...keys.watcher(iid, uid), uid, aid: ctx.meta.aid, iid, at: now, alerted: false });
  } else {
    tx.delete(keys.watch(uid, iid));
    tx.delete(keys.watcher(iid, uid));
  }
  await tx.run();
  return { watching: on };
}

/**
 * Items behind the user's WATCH# or BIDON# pointers, with everything needed
 * to show them as that user: auction rules, item, state, result, their
 * registration and their own sealed bid.
 */
export async function userItems(user, prefix) {
  if (!user) throw unauthorized();
  const rows = await query(`USER#${user.uid}`, prefix, { limit: 200 });
  if (!rows.length) return [];
  const found = await batchGet(rows.flatMap((r) => [
    keys.auction(r.aid), keys.item(r.aid, r.iid), keys.state(r.iid), keys.result(r.iid),
    keys.reg(r.aid, user.uid), keys.sealed(r.iid, user.uid), keys.watch(user.uid, r.iid),
  ]));
  return rows
    .map((r) => ({
      at: r.lastAt ?? r.at,
      meta: found.get(`AUC#${r.aid}|META`),
      item: found.get(`AUC#${r.aid}|ITEM#${r.iid}`),
      state: found.get(`ITEM#${r.iid}|STATE`),
      result: found.get(`ITEM#${r.iid}|RESULT`),
      reg: found.get(`AUC#${r.aid}|REG#${user.uid}`) ?? null,
      sealed: found.get(`ITEM#${r.iid}|SEALED#${user.uid}`),
      watching: found.has(`USER#${user.uid}|WATCH#${r.iid}`),
    }))
    .filter((x) => x.meta && x.item && x.meta.status !== 'draft')
    .sort((a, b) => b.at - a.at);
}

// ── Templates and cloning ─────────────────────────────────────────────

const withoutTiming = (rules) => {
  const out = structuredClone(rules);
  out.timing = { ...out.timing, opensAt: null, closesAt: null };
  return out;
};

export async function listTemplates(user) {
  if (!user) throw unauthorized();
  return (await query(`USER#${user.uid}`, 'TEMPLATE#')).map(({ id, name, rules, createdAt }) => ({ id, name, rules, createdAt }));
}

/** Saves rules (or an owned auction's rules) as a named template. Close times are dropped. */
export async function saveTemplate(user, body, now = Date.now()) {
  if (!user) throw unauthorized();
  const name = str(body.name, 'name', { min: 1, max: 60 });
  let rules = body.rules ?? {};
  if (body.fromAuction != null) {
    const meta = await get(keys.auction(str(body.fromAuction, 'fromAuction', { min: 1, max: 64 })));
    if (!meta || (meta.hostId !== user.uid && !user.admin)) throw notFound('Auction not found');
    rules = meta.rules;
  }
  const full = withoutTiming(validateRules(mergeRules(DEFAULT_RULES, rules)));
  if ((await query(`USER#${user.uid}`, 'TEMPLATE#')).length >= 50) throw conflict('too_many', 'Up to 50 templates');
  const id = newId(now);
  await put({ ...keys.template(user.uid, id), id, uid: user.uid, name, rules: full, createdAt: now });
  return { id, name, rules: full, createdAt: now };
}

export async function deleteTemplate(user, id) {
  if (!user) throw unauthorized();
  await deleteKeys([keys.template(user.uid, id)]);
  return { deleted: true };
}

const copyFields = (item) => {
  const overrides = item.overrides ? structuredClone(item.overrides) : undefined;
  if (overrides?.timing) delete overrides.timing;
  return {
    title: item.title, description: item.description, lot: item.lot, fields: item.fields, media: item.media,
    overrides: overrides && Object.keys(overrides).length ? overrides : undefined,
  };
};

/** A new draft with the same rules (close times cleared) and, by default, copies of the items. */
export async function cloneAuction(ctx, body, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  const title = str(body.title, 'title', { max: 120, optional: true }) ?? `${meta.title} (copy)`.slice(0, 120);
  const copy = await createAuction(ctx.user, { title, description: meta.description, rules: withoutTiming(meta.rules) }, now);
  let count = 0;
  if (body.withItems !== false) {
    const items = (await query(`AUC#${meta.aid}`, 'ITEM#')).sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < items.length; i += 98) {
      const tx = new Tx();
      for (const [j, item] of items.slice(i, i + 98).entries()) {
        const iid = randomUUID();
        tx.put({ ...keys.item(copy.aid, iid), iid, aid: copy.aid, createdAt: now + i + j, ...copyFields(item) });
      }
      tx.update(keys.auction(copy.aid), { add: ['itemCount :n'], values: { ':n': Math.min(98, items.length - i) } });
      await tx.run();
    }
    count = items.length;
  }
  const tx = new Tx();
  log(tx, copy.aid, actorOf(ctx.user), 'auction.cloned', { from: meta.aid, items: count }, now);
  await tx.run();
  return { ...copy, itemCount: count };
}

// ── CSV import ────────────────────────────────────────────────────────

/**
 * Columns: title (required), description, lot, start, reserve, buy_now,
 * closes_at (ISO), media (space-separated media/ keys) and field:<name>.
 * All rows import or none do; errors list their CSV row numbers.
 */
export async function importItems(ctx, body, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  if (meta.status === 'ended') throw conflict('auction_ended', 'This auction has ended');
  const rows = csvObjects(str(body.csv, 'csv', { min: 1, max: MB }));
  if (!rows.length) throw badRequest('invalid', 'The CSV has no data rows');
  if (rows.length > 500) throw badRequest('invalid', 'Import up to 500 rows at a time');
  const live = meta.status === 'live';
  const items = [];
  const errors = [];
  let staggered = meta.itemCount;
  rows.forEach((r, i) => {
    try {
      const whole = (v, name) => {
        if (!v) return undefined;
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw badRequest('invalid', `${name} must be a whole number`);
        return n;
      };
      const price = {};
      if (r.start) price.start = whole(r.start, 'start');
      if (r.reserve) price.reserve = whole(r.reserve, 'reserve');
      if (r.buy_now) price.buyNow = { amount: whole(r.buy_now, 'buy_now') };
      const overrides = {};
      if (Object.keys(price).length) overrides.price = price;
      if (r.closes_at) overrides.timing = { closesAt: r.closes_at };
      const fields = Object.fromEntries(Object.entries(r).filter(([k, v]) => k.startsWith('field:') && v).map(([k, v]) => [k.slice(6), v]));
      const fieldsIn = {
        title: r.title,
        description: r.description || undefined,
        lot: r.lot || undefined,
        fields: Object.keys(fields).length ? fields : undefined,
        media: r.media ? r.media.split(/\s+/).filter(Boolean) : undefined,
        overrides: Object.keys(overrides).length ? overrides : undefined,
      };
      const iid = randomUUID();
      const item = { ...keys.item(meta.aid, iid), iid, aid: meta.aid, createdAt: now + i, ...itemFields(fieldsIn, meta.rules) };
      let state = null;
      if (live) {
        const rules = effectiveRules(meta.rules, item.overrides);
        const index = item.overrides?.timing?.closesAt ? 0 : staggered++;
        state = stateRow(iid, meta.aid, { ...openingState(rules, index, now), version: 1 });
      }
      items.push({ item, state });
    } catch (err) {
      errors.push({ row: i + 2, message: err.message });
    }
  });
  if (errors.length) {
    throw badRequest('import_failed', `${errors.length} row(s) have problems; nothing was imported`, { errors: errors.slice(0, 50) });
  }
  const perTx = live ? 48 : 97;
  for (let i = 0; i < items.length; i += perTx) {
    const chunk = items.slice(i, i + perTx);
    const tx = new Tx();
    for (const { item, state } of chunk) {
      tx.put(item, { condition: 'attribute_not_exists(PK)' });
      if (state) tx.put(state, { condition: 'attribute_not_exists(PK)' });
    }
    tx.update(keys.auction(meta.aid), {
      add: live ? ['itemCount :n', 'openItems :n'] : ['itemCount :n'], values: { ':n': chunk.length },
    });
    if (i === 0) log(tx, meta.aid, actorOf(ctx.user), 'items.imported', { count: items.length }, now);
    await tx.run();
  }
  await Promise.all(items.filter((x) => x.state).map((x) => scheduleClose(x.item.iid, x.state.closesAt)));
  return { imported: items.length };
}

// ── Deleting ──────────────────────────────────────────────────────────

/** Items without bids (or offers) can go; an item with history stays. */
export async function deleteItem(ctx, iid, now = Date.now()) {
  requireOwner(ctx);
  const { meta } = ctx;
  const [item, state, offers] = await Promise.all([
    get(keys.item(meta.aid, iid)), get(keys.state(iid)), query(`ITEM#${iid}`, 'OFFER#', { limit: 1 }),
  ]);
  if (!item) throw notFound('Item not found');
  if (state && (state.bidCount > 0 || (state.pendingCount ?? 0) > 0 || state.status !== 'open' || offers.length)) {
    throw conflict('has_history', 'Only items without bids or offers can be deleted');
  }
  const tx = new Tx();
  tx.delete(keys.item(meta.aid, iid));
  if (state) tx.delete(keys.state(iid), { condition: '#v = :v', names: { '#v': 'version' }, values: { ':v': state.version }, reason: 'retry' });
  tx.update(keys.auction(meta.aid), {
    add: state ? ['itemCount :minus', 'openItems :minus'] : ['itemCount :minus'], values: { ':minus': -1 },
  });
  log(tx, meta.aid, actorOf(ctx.user), 'item.deleted', { target: iid, title: item.title }, now);
  await tx.run();
  return { deleted: true };
}

/** Drafts only. A published auction keeps its history. */
export async function deleteAuction(ctx) {
  requireOwner(ctx);
  const { meta } = ctx;
  if (meta.status !== 'draft') throw conflict('not_draft', 'Only a draft can be deleted');
  const rows = (await Promise.all(['ITEM#', 'LOG#'].map((p) => query(`AUC#${meta.aid}`, p)))).flat();
  await deleteKeys([...rows.map(({ PK, SK }) => ({ PK, SK })), keys.auction(meta.aid)]);
  return { deleted: true };
}

// ── Analytics ─────────────────────────────────────────────────────────

/** One write per auction page view by a non-owner. */
export async function countView(aid, now = Date.now()) {
  await update({
    Key: keys.stat(aid, day(now)),
    UpdateExpression: 'ADD #views :one SET aid = :aid',
    ExpressionAttributeNames: { '#views': 'views' },
    ExpressionAttributeValues: { ':one': 1, ':aid': aid },
  });
}

export async function analytics(ctx) {
  requireOwner(ctx);
  const { meta } = ctx;
  const aid = meta.aid;
  const [items, regs, chat, stats] = await Promise.all([
    query(`AUC#${aid}`, 'ITEM#'), query(`AUC#${aid}`, 'REG#'), query(`AUC#${aid}`, 'CHAT#'), query(`AUC#${aid}`, 'STAT#'),
  ]);
  const found = await batchGet(items.flatMap((i) => [keys.state(i.iid), keys.result(i.iid)]));
  const perItem = await Promise.all(items.map(async (item) => {
    const [bids, watchers] = await Promise.all([query(`ITEM#${item.iid}`, 'BID#'), query(`ITEM#${item.iid}`, 'WATCHER#')]);
    const accepted = bids.filter((b) => b.status === 'accepted');
    const state = found.get(`ITEM#${item.iid}|STATE`);
    const result = found.get(`ITEM#${item.iid}|RESULT`);
    return {
      id: item.iid,
      title: item.title,
      lot: item.lot ?? null,
      format: effectiveRules(meta.rules, item.overrides).format,
      status: state?.status ?? 'draft',
      bids: accepted.length,
      bidders: new Set(accepted.map((b) => b.uid)).size,
      pending: bids.filter((b) => b.status === 'pending').length,
      rejected: bids.filter((b) => b.status === 'rejected').length,
      watchers: watchers.length,
      price: result?.price ?? state?.price ?? null,
      outcome: result?.outcome ?? null,
      via: result?.via ?? null,
      acceptedTimes: accepted.map((b) => b.acceptedAt),
    };
  }));
  const closed = perItem.filter((i) => i.status === 'closed');
  const sold = closed.filter((i) => i.outcome === 'sold');
  const bidsByHour = {};
  for (const i of perItem) for (const t of i.acceptedTimes) {
    const hour = new Date(t).toISOString().slice(0, 13);
    bidsByHour[hour] = (bidsByHour[hour] ?? 0) + 1;
  }
  return {
    totals: {
      items: items.length,
      open: perItem.filter((i) => i.status === 'open').length,
      closed: closed.length,
      sold: sold.length,
      sellThrough: closed.length ? sold.length / closed.length : null,
      revenue: sold.reduce((sum, i) => sum + (i.price ?? 0), 0),
      currency: meta.rules.price.currency,
      bids: perItem.reduce((n, i) => n + i.bids, 0),
      bidders: new Set((await Promise.all(items.map((i) => query(`ITEM#${i.iid}`, 'BID#')))).flat()
        .filter((b) => b.status === 'accepted').map((b) => b.uid)).size,
      registrations: regs.length,
      approved: regs.filter((r) => r.status === 'approved').length,
      chatMessages: chat.length,
      views: stats.reduce((n, s) => n + (s.views ?? 0), 0),
    },
    viewsByDay: Object.fromEntries(stats.map((s) => [s.SK.slice(5), s.views ?? 0])),
    bidsByHour,
    items: perItem.map(({ acceptedTimes, ...rest }) => rest),
  };
}

// ── Invoices and payment status ───────────────────────────────────────

/** Sold items grouped by buyer. The owner sees every buyer; a buyer sees their own. */
export async function invoices(ctx) {
  if (!ctx.user) throw unauthorized();
  const { meta, viewer } = ctx;
  const items = await query(`AUC#${meta.aid}`, 'ITEM#');
  const results = await batchGet(items.map((i) => keys.result(i.iid)));
  const byBuyer = new Map();
  for (const item of items) {
    const r = results.get(`ITEM#${item.iid}|RESULT`);
    if (!r || r.outcome !== 'sold') continue;
    if (!viewer.owner && r.winnerId !== viewer.uid) continue;
    if (!byBuyer.has(r.winnerId)) byBuyer.set(r.winnerId, { tag: r.winnerTag, lines: [] });
    byBuyer.get(r.winnerId).lines.push({
      itemId: item.iid, title: item.title, lot: item.lot ?? null, price: r.price, currency: r.currency, via: r.via,
      payment: r.payment ?? { status: 'unpaid' }, fulfillment: r.fulfillment ?? { status: 'pending' }, at: r.at,
      dueAt: r.at + meta.rules.payment.dueHours * 3600_000, charged: r.charged ?? 0,
    });
  }
  return [...byBuyer].map(([uid, { tag, lines }]) => ({
    buyer: viewer.owner ? { uid, label: tag?.name ?? tag?.alias, alias: tag?.alias, paddle: tag?.paddle } : { you: true, label: 'You' },
    lines,
    total: lines.reduce((n, l) => n + l.price, 0),
    unpaid: lines.filter((l) => l.payment.status === 'unpaid').reduce((n, l) => n + l.price, 0),
    instructions: meta.rules.payment.instructions || null,
  }));
}

export async function setResult(ctx, iid, body, now = Date.now()) {
  requireOwner(ctx);
  const result = await get(keys.result(iid));
  if (!result || result.aid !== ctx.meta.aid) throw notFound('This item has no result yet');
  if (result.outcome !== 'sold') throw conflict('not_sold', 'Only sold items have payment and delivery');
  const next = { ...result, updatedAt: now };
  if (body.payment !== undefined) {
    next.payment = {
      status: oneOf(body.payment?.status, 'payment.status', ['unpaid', 'paid', 'waived', 'refunded']),
      note: str(body.payment?.note, 'payment.note', { max: 200, optional: true }),
      at: now,
    };
  }
  if (body.fulfillment !== undefined) {
    next.fulfillment = {
      status: oneOf(body.fulfillment?.status, 'fulfillment.status', ['pending', 'shipped', 'picked_up', 'delivered']),
      tracking: str(body.fulfillment?.tracking, 'fulfillment.tracking', { max: 100, optional: true }),
      at: now,
    };
  }
  const tx = new Tx();
  tx.put(next, { condition: 'attribute_not_exists(updatedAt) OR updatedAt = :u', values: { ':u': result.updatedAt ?? 0 }, reason: 'stale' });
  log(tx, ctx.meta.aid, actorOf(ctx.user), 'result.updated', { iid, payment: next.payment?.status, fulfillment: next.fulfillment?.status }, now);
  await tx.run();
  return next;
}

// ── Uploads ───────────────────────────────────────────────────────────

// Same allowlist and caps as functions/media, which re-checks the real bytes.
const UPLOAD_TYPES = {
  'image/jpeg': ['.jpg', 25 * MB],
  'image/png': ['.png', 25 * MB],
  'image/gif': ['.gif', 25 * MB],
  'image/webp': ['.webp', 25 * MB],
  'image/avif': ['.avif', 25 * MB],
  'video/mp4': ['.mp4', 500 * MB],
  'video/quicktime': ['.mov', 500 * MB],
  'application/pdf': ['.pdf', 50 * MB],
  'model/gltf-binary': ['.glb', 50 * MB],
};

/**
 * A presigned POST straight to S3 incoming/. The media function checks the
 * file, moves it to media/ and attaches it to the item.
 */
export async function presignUpload(ctx, iid, body) {
  requireOwner(ctx);
  const item = await get(keys.item(ctx.meta.aid, iid));
  if (!item) throw notFound('Item not found');
  if ((item.media?.length ?? 0) >= 20) throw conflict('too_many_files', 'An item holds up to 20 files');
  const type = oneOf(body.contentType, 'contentType', Object.keys(UPLOAD_TYPES));
  const [ext, cap] = UPLOAD_TYPES[type];
  const size = int(body.size, 'size', { min: 1, max: cap });
  const key = `incoming/${ctx.meta.aid}/${iid}/${randomUUID()}${ext}`;
  return { ...presignPost({ bucket: process.env.MEDIA_BUCKET, key, maxBytes: size }), mediaKey: key.replace(/^incoming\//, 'media/') };
}

// ── Notifications and Web Push ────────────────────────────────────────

export async function listNotes(user, limit = 50) {
  if (!user) throw unauthorized();
  const rows = await query(`USER#${user.uid}`, 'NOTE#', { desc: true, limit: Math.min(Math.max(Number(limit) || 50, 1), 100) });
  return rows.map(({ SK, at, type, text, url, aid, iid }) => ({ id: SK.slice(5), at, type, text, url, auctionId: aid ?? null, itemId: iid ?? null }));
}

export const pushKey = async () => (await vapidKeys()).publicKey;

export async function subscribePush(user, body, now = Date.now()) {
  if (!user) throw unauthorized();
  const sub = body.subscription ?? {};
  const endpoint = str(sub.endpoint, 'subscription.endpoint', { min: 10, max: 1000 });
  if (!validEndpoint(endpoint)) throw badRequest('invalid', 'That is not a known browser push service');
  const p256dh = str(sub.keys?.p256dh, 'subscription.keys.p256dh', { min: 20, max: 200 });
  const auth = str(sub.keys?.auth, 'subscription.keys.auth', { min: 8, max: 100 });
  const existing = await query(`USER#${user.uid}`, 'PUSH#');
  const hash = pushHash(endpoint);
  if (existing.length >= 10 && !existing.some((r) => r.SK === `PUSH#${hash}`)) throw conflict('too_many', 'Up to 10 browsers per account');
  await put({ ...keys.push(user.uid, hash), uid: user.uid, subscription: { endpoint, keys: { p256dh, auth } }, createdAt: now });
  return { subscribed: true };
}

export async function unsubscribePush(user, body) {
  if (!user) throw unauthorized();
  const endpoint = str(body.endpoint, 'endpoint', { min: 10, max: 1000 });
  await deleteKeys([keys.push(user.uid, pushHash(endpoint))]);
  return { subscribed: false };
}
