// /api/* router behind CloudFront. Every response is shaped for the caller by
// lib/visibility.mjs; nothing reads a raw row back to the browser.

import { authenticate } from '../lib/auth.mjs';
import { keys, get, query, queryIndex, batchGet, TxConflict } from '../lib/db.mjs';
import {
  HttpError, json, csv, parseBody, notFound, forbidden, oneOf,
} from '../lib/http.mjs';
import { RuleError, effectiveRules, isSealed, DEFAULT_RULES, FORMATS, BOARD_COLUMNS } from '../lib/rules.mjs';
import {
  allowed, canSee, viewState, viewBid, viewChat, viewRules, board, maskMap, label,
} from '../lib/visibility.mjs';
import * as ops from '../lib/auction.mjs';
import * as extras from '../lib/extras.mjs';

// ── Views ─────────────────────────────────────────────────────────────

function viewAuction(ctx, extra = {}) {
  const { meta, viewer } = ctx;
  return {
    id: meta.aid,
    title: meta.title,
    description: meta.description,
    status: meta.status,
    host: meta.hostName,
    itemCount: meta.itemCount,
    openItems: meta.openItems,
    createdAt: meta.createdAt,
    publishedAt: meta.publishedAt ?? null,
    endedAt: meta.endedAt ?? null,
    rules: viewRules(viewer, meta.rules),
    locked: false,
    you: {
      signedIn: !!viewer.uid,
      owner: viewer.owner,
      registration: viewer.reg ? viewReg(viewer.reg, true) : null,
    },
    ...extra,
  };
}

const listCard = (meta) => ({
  id: meta.aid, title: meta.title, status: meta.status, host: meta.hostName,
  itemCount: meta.itemCount, openItems: meta.openItems, createdAt: meta.createdAt,
});

function viewReg(reg, full) {
  const base = { uid: reg.uid, alias: reg.alias, paddle: reg.paddle, status: reg.status, createdAt: reg.createdAt };
  if (!full) return base;
  return {
    ...base, name: reg.name, email: reg.email, groups: reg.groups ?? [], see: reg.see ?? {},
    bidLimit: reg.bidLimit ?? null, muted: !!reg.muted, note: reg.note ?? null,
  };
}

const viewBalance = (bal) => (bal
  ? { balance: bal.balance, available: bal.available, committed: bal.committed ?? 0, updatedAt: bal.updatedAt }
  : { balance: 0, available: 0, committed: 0, updatedAt: null });

/** What a locked (code-only) auction shows before the viewer joins. */
const lockedAuction = (ctx) => ({
  id: ctx.meta.aid, title: ctx.meta.title, host: ctx.meta.hostName, status: ctx.meta.status, locked: true,
  you: { signedIn: !!ctx.viewer.uid, owner: false, registration: ctx.viewer.reg ? viewReg(ctx.viewer.reg, true) : null },
});

function viewItem(ctx, item, state, result, own = {}) {
  const rules = effectiveRules(ctx.rules, item.overrides);
  return {
    id: item.iid,
    auctionId: item.aid,
    title: item.title,
    description: item.description ?? '',
    lot: item.lot ?? null,
    fields: item.fields ?? {},
    media: item.media ?? [],
    increment: rules.increment.mode === 'bidder_choice'
      ? { mode: 'bidder_choice', presets: rules.increment.bidderChoice.presets }
      : { mode: rules.increment.mode },
    format: rules.format,
    proxy: rules.proxy.enabled && rules.format === 'english',
    offers: rules.format === 'fixed_price' && rules.price.offers.enabled,
    approval: rules.bidApproval.mode === 'none' ? null
      : { mode: rules.bidApproval.mode, threshold: rules.bidApproval.mode === 'above' ? rules.bidApproval.threshold : null },
    currency: rules.price.currency,
    start: rules.price.start,
    overrides: ctx.viewer.owner ? item.overrides ?? null : undefined,
    watching: ctx.viewer.uid ? !!own.watching : undefined,
    state: state ? viewState(ctx.viewer, rules, state, result, own) : { status: 'draft' },
  };
}

async function itemBundle(ctx, iid) {
  const uid = ctx.viewer.uid;
  const found = await batchGet([keys.item(ctx.meta.aid, iid), keys.state(iid), keys.result(iid), ...(uid ? [keys.sealed(iid, uid), keys.watch(uid, iid)] : [])]);
  const item = found.get(`AUC#${ctx.meta.aid}|ITEM#${iid}`);
  if (!item) throw notFound('Item not found');
  return {
    item,
    state: found.get(`ITEM#${iid}|STATE`),
    result: found.get(`ITEM#${iid}|RESULT`),
    own: uid ? { sealed: found.get(`ITEM#${iid}|SEALED#${uid}`), watching: found.has(`USER#${uid}|WATCH#${iid}`) } : {},
  };
}

const itemOut = (ctx, b) => viewItem(ctx, b.item, b.state, b.result, b.own);

/** Items from the user's watchlist or bids, each seen through that auction's rules. */
function userItemViews(user, rows) {
  return rows.map((x) => {
    const owner = x.meta.hostId === user.uid || user.admin;
    const ctx = { meta: x.meta, rules: x.meta.rules, viewer: { uid: user.uid, owner, reg: owner ? null : x.reg } };
    if (x.meta.rules.access.mode === 'code' && !owner && (!x.reg || x.reg.status === 'blocked')) return null;
    return { auction: { id: x.meta.aid, title: x.meta.title, status: x.meta.status }, item: viewItem(ctx, x.item, x.state, x.result, { sealed: x.sealed, watching: x.watching }) };
  }).filter(Boolean);
}

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', 'Sign in first');
}

// ── Routes ────────────────────────────────────────────────────────────

const routes = [];
const route = (method, pattern, handler) => {
  const names = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([A-Za-z0-9-]{1,64})'; })}$`);
  routes.push({ method, re, names, handler });
};

route('GET', '/api/health', () => json(200, { ok: true, stage: process.env.STAGE }));
// Every setting with its default, so the console can build its forms from one source.
route('GET', '/api/rules/defaults', () => json(200, { rules: DEFAULT_RULES, formats: FORMATS, boardColumns: BOARD_COLUMNS }));

route('GET', '/api/auctions', async ({ user, qs }) => {
  const scope = oneOf(qs.scope ?? 'live', 'scope', ['live', 'mine', 'joined']);
  let metas;
  if (scope === 'live') metas = await queryIndex('GSI1', 'AUC#live', { limit: 100 });
  else {
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in first');
    if (scope === 'mine') metas = await queryIndex('GSI2', `HOST#${user.uid}`, { limit: 100 });
    else {
      const regs = await queryIndex('GSI2', `MEMBER#${user.uid}`, { limit: 100 });
      const found = await batchGet(regs.map((r) => keys.auction(r.aid)));
      metas = regs.map((r) => found.get(`AUC#${r.aid}|META`)).filter((m) => m && m.status !== 'draft');
    }
  }
  return json(200, { auctions: metas.map(listCard) });
});

route('POST', '/api/auctions', async ({ user, body }) => {
  const meta = await ops.createAuction(user, body);
  return json(201, { auction: viewAuction({ meta, rules: meta.rules, viewer: { uid: user.uid, owner: true, reg: null } }) });
});

route('GET', '/api/auctions/:aid', async ({ ctx }) => {
  if (ctx.locked) return json(200, { auction: lockedAuction(ctx) });
  if (!ctx.viewer.owner) await extras.countView(ctx.meta.aid).catch(() => {}); // one write per page view
  const extra = {};
  if (ctx.viewer.reg && ctx.rules.balance.enabled && ctx.rules.balance.showToBidder) {
    extra.balance = viewBalance(await get(keys.balance(ctx.meta.aid, ctx.viewer.uid)));
  }
  if (ctx.viewer.owner) {
    extra.pendingBids = (await query(`AUC#${ctx.meta.aid}`, 'PENDING#')).length;
  }
  return json(200, { auction: viewAuction(ctx, extra) });
});

route('PATCH', '/api/auctions/:aid', async ({ ctx, body }) => {
  const meta = await ops.updateAuction(ctx, body);
  return json(200, { auction: viewAuction({ ...ctx, meta, rules: meta.rules }) });
});

route('POST', '/api/auctions/:aid/publish', async ({ ctx }) => {
  const meta = await ops.publishAuction(ctx);
  return json(200, { auction: viewAuction({ ...ctx, meta }) });
});

route('GET', '/api/auctions/:aid/items', async ({ ctx }) => {
  const uid = ctx.viewer.uid;
  const items = (await query(`AUC#${ctx.meta.aid}`, 'ITEM#')).sort((a, b) => a.createdAt - b.createdAt);
  const found = await batchGet(items.flatMap((i) => [keys.state(i.iid), keys.result(i.iid), ...(uid ? [keys.sealed(i.iid, uid), keys.watch(uid, i.iid)] : [])]));
  return json(200, {
    items: items.map((i) => viewItem(ctx, i, found.get(`ITEM#${i.iid}|STATE`), found.get(`ITEM#${i.iid}|RESULT`),
      uid ? { sealed: found.get(`ITEM#${i.iid}|SEALED#${uid}`), watching: found.has(`USER#${uid}|WATCH#${i.iid}`) } : {})),
  });
});

route('POST', '/api/auctions/:aid/items', async ({ ctx, body }) => {
  const item = await ops.createItem(ctx, body);
  return json(201, { item: itemOut(ctx, await itemBundle(ctx, item.iid)) });
});

route('POST', '/api/auctions/:aid/items/import', async ({ ctx, body }) => json(201, await extras.importItems(ctx, body)));

route('GET', '/api/auctions/:aid/items/:iid', async ({ ctx, params }) => json(200, { item: itemOut(ctx, await itemBundle(ctx, params.iid)) }));

route('PATCH', '/api/auctions/:aid/items/:iid', async ({ ctx, params, body }) => {
  await ops.updateItem(ctx, params.iid, body);
  return json(200, { item: itemOut(ctx, await itemBundle(ctx, params.iid)) });
});

route('DELETE', '/api/auctions/:aid/items/:iid', async ({ ctx, params }) => json(200, await extras.deleteItem(ctx, params.iid)));

route('POST', '/api/auctions/:aid/items/:iid/bids', async ({ ctx, params, body }) => {
  const out = await ops.placeBid(ctx, params.iid, body);
  return json(out.status === 'pending' ? 202 : 201, { ...out, item: itemOut(ctx, await itemBundle(ctx, params.iid)) });
});

route('GET', '/api/auctions/:aid/items/:iid/bids', async ({ ctx, params }) => {
  const { item, state } = await itemBundle(ctx, params.iid);
  const rules = effectiveRules(ctx.rules, item.overrides);
  const bids = await query(`ITEM#${params.iid}`, 'BID#', { desc: true });
  const masks = maskMap(bids);
  const sealedOpen = isSealed(rules) && state?.status === 'open';
  return json(200, {
    bids: bids.map((b) => viewBid(ctx.viewer, rules, b, masks, { sealedOpen })).filter(Boolean),
    historyVisible: canSee(ctx.viewer, rules, 'history') && !sealedOpen,
  });
});

route('POST', '/api/auctions/:aid/items/:iid/buy', async ({ ctx, params }) => {
  const out = await ops.buyNow(ctx, params.iid);
  return json(201, { ...out, item: itemOut(ctx, await itemBundle(ctx, params.iid)) });
});

const viewOffer = (ctx, iid, offer) => ops.listOffers(ctx, iid).then((all) => all.find((o) => o.id === offer.oid));

route('GET', '/api/auctions/:aid/items/:iid/offers', async ({ ctx, params }) => json(200, { offers: await ops.listOffers(ctx, params.iid) }));
route('POST', '/api/auctions/:aid/items/:iid/offers', async ({ ctx, params, body }) => {
  const offer = await ops.makeOffer(ctx, params.iid, body);
  return json(201, { offer: await viewOffer(ctx, params.iid, offer) });
});
route('POST', '/api/auctions/:aid/items/:iid/offers/:oid/decision', async ({ ctx, params, body }) => {
  const offer = await ops.decideOffer(ctx, params.iid, params.oid, body);
  return json(200, { offer: await viewOffer(ctx, params.iid, offer) });
});
route('POST', '/api/auctions/:aid/items/:iid/offers/:oid/respond', async ({ ctx, params, body }) => {
  const offer = await ops.respondOffer(ctx, params.iid, params.oid, body);
  return json(200, { offer: await viewOffer(ctx, params.iid, offer) });
});
route('DELETE', '/api/auctions/:aid/items/:iid/offers/:oid', async ({ ctx, params }) => {
  await ops.withdrawOffer(ctx, params.iid, params.oid);
  return json(200, { withdrawn: true });
});

route('POST', '/api/auctions/:aid/items/:iid/watch', async ({ ctx, params }) => json(200, await extras.setWatch(ctx, params.iid, true)));
route('DELETE', '/api/auctions/:aid/items/:iid/watch', async ({ ctx, params }) => json(200, await extras.setWatch(ctx, params.iid, false)));
route('POST', '/api/auctions/:aid/items/:iid/uploads', async ({ ctx, params, body }) => json(201, { upload: await extras.presignUpload(ctx, params.iid, body) }));
route('PATCH', '/api/auctions/:aid/items/:iid/result', async ({ ctx, params, body }) => {
  const r = await extras.setResult(ctx, params.iid, body);
  return json(200, { payment: r.payment, fulfillment: r.fulfillment });
});

route('DELETE', '/api/auctions/:aid', async ({ ctx }) => json(200, await extras.deleteAuction(ctx)));
route('POST', '/api/auctions/:aid/clone', async ({ ctx, body }) => {
  const meta = await extras.cloneAuction(ctx, body);
  return json(201, { auction: { id: meta.aid, title: meta.title, status: meta.status, itemCount: meta.itemCount } });
});
route('GET', '/api/auctions/:aid/invoices', async ({ ctx }) => json(200, { invoices: await extras.invoices(ctx) }));
route('GET', '/api/auctions/:aid/analytics', async ({ ctx }) => json(200, { analytics: await extras.analytics(ctx) }));

// ── The signed-in user ──
route('GET', '/api/me/watchlist', async ({ user }) => json(200, { items: userItemViews(user, await extras.userItems(user, 'WATCH#')) }));
route('GET', '/api/me/bids', async ({ user }) => json(200, { items: userItemViews(user, await extras.userItems(user, 'BIDON#')) }));
route('GET', '/api/me/notifications', async ({ user, qs }) => json(200, { notifications: await extras.listNotes(user, qs.limit) }));
route('POST', '/api/me/push', async ({ user, body }) => json(201, await extras.subscribePush(user, body)));
route('DELETE', '/api/me/push', async ({ user, qs }) => json(200, await extras.unsubscribePush(user, { endpoint: qs.endpoint })));
route('GET', '/api/push/key', async () => json(200, { publicKey: await extras.pushKey() }));
route('GET', '/api/templates', async ({ user }) => json(200, { templates: await extras.listTemplates(user) }));
route('POST', '/api/templates', async ({ user, body }) => json(201, { template: await extras.saveTemplate(user, body) }));
route('DELETE', '/api/templates/:id', async ({ user, params }) => json(200, await extras.deleteTemplate(user, params.id)));

route('GET', '/api/auctions/:aid/items/:iid/board', async ({ ctx, params }) => {
  const { item, state } = await itemBundle(ctx, params.iid);
  if (!state) return json(200, { board: null });
  const rules = effectiveRules(ctx.rules, item.overrides);
  const bids = await query(`ITEM#${params.iid}`, 'BID#');
  return json(200, { board: board(ctx.viewer, rules, state, bids) });
});

route('POST', '/api/auctions/:aid/items/:iid/bids/:bidId/decision', async ({ ctx, params, body }) => {
  const out = await ops.decideBid(ctx, params.iid, params.bidId, body);
  return json(200, { ...out, state: undefined });
});

route('POST', '/api/auctions/:aid/items/:iid/bids/:bidId/cancel', async ({ ctx, params, body }) => {
  const out = await ops.cancelBid(ctx, params.iid, params.bidId, body);
  return json(200, { ...out, state: undefined });
});

route('DELETE', '/api/auctions/:aid/items/:iid/bids/:bidId', async ({ ctx, params }) => (
  json(200, await ops.withdrawBid(ctx, params.iid, params.bidId))
));

route('POST', '/api/auctions/:aid/register', async ({ ctx, body }) => {
  const reg = await ops.register(ctx, body);
  return json(201, { registration: viewReg(reg, true) });
});

// Owner: every registration with balances. Others: the participant list, if visible.
route('GET', '/api/auctions/:aid/registrations', async ({ ctx }) => {
  const regs = await query(`AUC#${ctx.meta.aid}`, 'REG#');
  if (ctx.viewer.owner) {
    const bals = new Map((await query(`AUC#${ctx.meta.aid}`, 'BAL#')).map((b) => [b.uid, b]));
    return json(200, {
      registrations: regs.map((r) => ({ ...viewReg(r, true), balance: viewBalance(bals.get(r.uid)) })),
    });
  }
  if (!canSee(ctx.viewer, ctx.rules, 'participants')) throw forbidden('The participant list is private');
  const reveal = canSee(ctx.viewer, ctx.rules, 'historyIdentities');
  const approved = regs.filter((r) => r.status === 'approved');
  return json(200, {
    participants: approved.map((r, i) => ({
      label: r.uid === ctx.viewer.uid ? 'You' : reveal ? label(ctx.rules.identity, r, `Bidder ${i + 1}`) : `Bidder ${i + 1}`,
    })),
    count: approved.length,
  });
});

route('PATCH', '/api/auctions/:aid/registrations/:uid', async ({ ctx, params, body }) => {
  const reg = await ops.updateRegistration(ctx, params.uid, body);
  return json(200, { registration: viewReg(reg, true) });
});

route('POST', '/api/auctions/:aid/balances/:uid', async ({ ctx, params, body }) => {
  const bal = await ops.adjustBalance(ctx, params.uid, body);
  return json(200, { balance: viewBalance(bal) });
});

// Owner: everyone's ledger (or ?uid=). Bidders: their own.
route('GET', '/api/auctions/:aid/ledger', async ({ ctx, qs }) => {
  requireUser(ctx);
  const uid = ctx.viewer.owner ? qs.uid : ctx.viewer.uid;
  if (!ctx.viewer.owner && !ctx.viewer.reg) throw forbidden('Register first');
  const rows = await query(`AUC#${ctx.meta.aid}`, uid ? `LEDGER#${uid}#` : 'LEDGER#');
  const entries = rows.sort((a, b) => b.at - a.at).map((r) => ({
    uid: ctx.viewer.owner ? r.uid : undefined,
    at: r.at, delta: r.delta, type: r.type, reason: r.reason, item: r.iid ?? null,
    by: r.byName, balanceAfter: r.balanceAfter ?? null,
  }));
  return json(200, { entries });
});

route('GET', '/api/auctions/:aid/pending', async ({ ctx }) => {
  ops.requireOwner(ctx);
  const markers = await query(`AUC#${ctx.meta.aid}`, 'PENDING#');
  const found = await batchGet(markers.map((m) => keys.bid(m.iid, m.bidId)));
  const bids = markers.map((m) => found.get(`ITEM#${m.iid}|BID#${m.bidId}`)).filter((b) => b?.status === 'pending');
  return json(200, {
    pending: bids.map((b) => ({ itemId: b.iid, ...viewBid(ctx.viewer, ctx.rules, b, new Map()) })),
  });
});

route('GET', '/api/auctions/:aid/history', async ({ ctx, qs }) => {
  ops.requireOwner(ctx);
  const limit = Math.min(Math.max(Number(qs.limit) || 100, 1), 500);
  const rows = await query(`AUC#${ctx.meta.aid}`, 'LOG#', { desc: true, limit, before: qs.before });
  // BETWEEN is inclusive, so the cursor row itself comes back first: drop it.
  const entries = rows.map(({ PK, SK, aid, ...r }) => ({ id: SK.slice(4), ...r })).filter((e) => e.id !== qs.before);
  return json(200, { entries, next: rows.length === limit ? entries.at(-1).id : null });
});

route('GET', '/api/auctions/:aid/export', async ({ ctx, qs }) => {
  ops.requireOwner(ctx);
  const type = oneOf(qs.type ?? 'bids', 'type', ['bids', 'ledger', 'history', 'chat']);
  const aid = ctx.meta.aid;
  const name = `${aid.slice(0, 8)}-${type}.csv`;
  if (type === 'bids') {
    const items = await query(`AUC#${aid}`, 'ITEM#');
    const rows = [['item', 'lot', 'bidId', 'bidder', 'alias', 'paddle', 'amount', 'max', 'status', 'kind', 'placedAt', 'acceptedAt', 'decidedBy', 'reason']];
    for (const item of items) {
      for (const b of await query(`ITEM#${item.iid}`, 'BID#')) {
        rows.push([item.title, item.lot, b.bidId, b.tag?.name, b.tag?.alias, b.tag?.paddle, b.amount, b.max,
          b.status, b.kind, iso(b.placedAt), iso(b.acceptedAt), b.decidedBy, b.reason]);
      }
    }
    return csv(name, rows);
  }
  if (type === 'ledger') {
    const rows = await query(`AUC#${aid}`, 'LEDGER#');
    return csv(name, [['at', 'uid', 'delta', 'type', 'reason', 'item', 'by', 'balanceAfter'],
      ...rows.map((r) => [iso(r.at), r.uid, r.delta, r.type, r.reason, r.iid, r.byName, r.balanceAfter])]);
  }
  if (type === 'history') {
    const rows = await query(`AUC#${aid}`, 'LOG#');
    return csv(name, [['at', 'actor', 'action', 'target', 'details'],
      ...rows.map(({ PK, SK, aid: _, at, actor, actorName, action, target, ...rest }) => [iso(at), actorName ?? actor, action, target, rest])]);
  }
  const rows = await query(`AUC#${aid}`, 'CHAT#');
  return csv(name, [['at', 'role', 'author', 'paddle', 'text', 'deleted'],
    ...rows.map((m) => [iso(m.at), m.role, m.tag?.name ?? m.tag?.alias, m.tag?.paddle, m.text, !!m.deleted])]);
});

route('GET', '/api/auctions/:aid/chat', async ({ ctx, qs }) => {
  const rows = await ops.listChat(ctx, { after: qs.after, limit: qs.limit });
  return json(200, {
    messages: rows.map((m) => viewChat(ctx.viewer, ctx.rules, m)),
    canPost: canPost(ctx),
  });
});

route('POST', '/api/auctions/:aid/chat', async ({ ctx, body }) => {
  const msg = await ops.postChat(ctx, body);
  return json(201, { message: viewChat(ctx.viewer, ctx.rules, msg) });
});

route('DELETE', '/api/auctions/:aid/chat/:id', async ({ ctx, params }) => json(200, await ops.deleteChat(ctx, params.id)));

function canPost(ctx) {
  const { viewer, rules } = ctx;
  if (viewer.owner) return true;
  const chat = rules.chat;
  return chat.enabled && !chat.hostOnly && !!viewer.reg && !viewer.reg.muted && allowed(viewer, chat.post);
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : '');

// ── Handler ───────────────────────────────────────────────────────────

export const handler = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '') || '/';
  try {
    const candidates = routes.filter((r) => r.re.test(path));
    if (!candidates.length) throw notFound(`No route for ${path}`);
    const match = candidates.find((r) => r.method === method);
    if (!match) throw new HttpError(405, 'method_not_allowed', `${method} is not allowed here`);
    const values = match.re.exec(path).slice(1);
    const params = Object.fromEntries(match.names.map((n, i) => [n, values[i]]));
    const user = await authenticate(event.headers);
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? parseBody(event) : {};
    const qs = event.queryStringParameters ?? {};
    const ctx = params.aid ? await ops.loadAuction(params.aid, user) : null;
    // A code-only auction: until they join, outsiders get the title and the join route.
    const openToLocked = (method === 'GET' && /^\/api\/auctions\/[A-Za-z0-9-]{1,64}$/.test(path))
      || (method === 'POST' && path.endsWith('/register'));
    if (ctx?.locked && !openToLocked) throw new HttpError(403, 'access_code_required', 'Join this auction with its access code or invite first');
    return await match.handler({ user, ctx, params, body, qs, event });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message, ...err.details });
    if (err instanceof RuleError) return json(409, { error: err.code, message: err.message, ...err.details });
    if (err instanceof TxConflict) {
      if (err.reason === 'insufficient_balance') return json(409, { error: 'insufficient_balance', message: 'Not enough balance for this bid' });
      return json(409, { error: err.reason, message: 'Something changed meanwhile. Reload and try again.' });
    }
    console.error(JSON.stringify({ msg: 'unhandled', method, path, error: err.stack ?? String(err) }));
    return json(500, { error: 'internal', message: 'Something went wrong' });
  }
};

