// Who sees what. Every response and every live push goes through these
// functions, so a hidden field never leaves the server.
//
// A viewer is { uid, owner, reg }:
//   owner  the auction's host (or a platform admin): sees everything
//   reg    the viewer's registration for this auction, or null

import { maxRaise, isSealed, dutchPrice, nextDutchDrop, buyNowPrice } from './rules.mjs';

export const ANONYMOUS = Object.freeze({ uid: null, owner: false, reg: null });

/** Does the viewer fall inside an audience (public, registered, approved, owner, group:x)? */
export function allowed(viewer, audience) {
  if (viewer.owner) return true;
  if (audience === 'public') return true;
  const reg = viewer.reg;
  if (!reg || reg.status === 'blocked') return false;
  if (audience === 'registered') return true;
  if (audience === 'approved') return reg.status === 'approved';
  if (audience.startsWith('group:')) {
    return reg.status === 'approved' && (reg.groups ?? []).includes(audience.slice(6));
  }
  return false; // 'owner'
}

/** Visibility of one field. A per-bidder override (reg.see) beats the audience. */
export function canSee(viewer, rules, field) {
  if (viewer.owner) return true;
  const reg = viewer.reg;
  if (reg && reg.status !== 'blocked' && typeof reg.see?.[field] === 'boolean') return reg.see[field];
  return allowed(viewer, rules.visibility[field]);
}

/** Display name for a registration (tag = { alias, paddle, name }). */
export function label(style, tag, fallback) {
  if (!tag) return fallback;
  if (style === 'paddle' && tag.paddle != null) return `Paddle ${tag.paddle}`;
  if (style === 'name' && tag.name) return tag.name;
  return tag.alias || fallback;
}

/** Tag stored on rows that name a bidder, so reads need no extra lookup. */
export const tagOf = (reg) => (reg ? { alias: reg.alias, paddle: reg.paddle, name: reg.name } : null);

/** How the viewer sees a bidder: themselves, the owner's full view, revealed or masked. */
export function who(viewer, rules, uid, tag, mask = 'Another bidder') {
  if (!uid) return null;
  if (uid === viewer.uid) return { you: true, label: 'You' };
  if (viewer.owner) {
    return { uid, label: label('name', tag, mask), alias: tag?.alias, paddle: tag?.paddle, name: tag?.name };
  }
  if (canSee(viewer, rules, 'historyIdentities')) return { label: label(rules.identity, tag, mask) };
  return { label: mask };
}

/** "Bidder 1, 2, 3" in order of each bidder's first accepted bid. */
export function maskMap(bids) {
  const masks = new Map();
  const accepted = bids.filter((b) => b.status === 'accepted').sort((a, b) => a.acceptedAt - b.acceptedAt);
  for (const b of accepted) if (!masks.has(b.uid)) masks.set(b.uid, `Bidder ${masks.size + 1}`);
  return masks;
}

/**
 * Live item state as this viewer may see it. While a sealed item is open
 * nobody, the owner included, sees the price or the leader.
 * own = { sealed } : the viewer's own sealed bid, if any.
 */
export function viewState(viewer, rules, state, result, own = {}, now = Date.now()) {
  const see = (field) => canSee(viewer, rules, field);
  const open = state.status === 'open';
  const sealedOpen = isSealed(rules) && open;
  const dutchOpen = rules.format === 'dutch' && open;
  const leading = viewer.uid != null && state.leaderId === viewer.uid && !sealedOpen;
  let price = state.price;
  if (dutchOpen) price = dutchPrice(rules, state, now);
  else if (rules.format === 'fixed_price' && open) price = rules.price.start;
  else if (sealedOpen) price = null;
  const out = {
    format: rules.format,
    direction: rules.format === 'reverse' ? 'down' : 'up',
    status: state.status,
    opensAt: state.opensAt,
    closesAt: see('closesAt') ? state.closesAt : null,
    extensions: see('closesAt') ? state.extensions : null,
    price: see('price') ? price : null,
    bidCount: see('bidCount') ? state.bidCount : null,
    nextMin: see('nextMin') ? (dutchOpen ? price : state.nextMin) : null,
    maxBid: see('nextMin') ? maxRaise(state, rules) : null,
    buyNow: buyNowPrice(state, rules),
    reserve: {
      exists: !!state.hasReserve,
      met: state.hasReserve && see('reserveStatus') && !sealedOpen ? state.reserveMet : null,
      amount: state.hasReserve && see('reserveAmount') ? rules.price.reserve : null,
    },
    leader: see('leader') && !sealedOpen ? who(viewer, rules, state.leaderId, state.leaderTag) : null,
    you: viewer.uid ? { leading, max: leading && rules.format === 'english' ? state.leaderMax : null, sealedBid: own.sealed?.amount ?? null } : null,
    version: state.version,
  };
  if (dutchOpen) out.dutch = { floor: rules.price.dutch.floor, step: rules.price.dutch.step, nextDropAt: nextDutchDrop(rules, state, now) };
  if (viewer.owner) {
    out.pendingCount = state.pendingCount ?? 0;
    out.leaderMax = rules.proxy.hostSeesMax && rules.format === 'english' ? state.leaderMax : null;
  }
  if (result) {
    const isWinner = viewer.uid != null && result.winnerId === viewer.uid;
    out.result = {
      outcome: result.outcome,
      via: result.via ?? 'auction',
      price: see('price') || isWinner ? result.price : null,
      winner: viewer.owner || isWinner || see('leader') ? who(viewer, rules, result.winnerId, result.winnerTag) : null,
      at: result.at,
    };
    if (viewer.owner || isWinner) {
      out.result.payment = result.payment ?? { status: 'unpaid' };
      out.result.fulfillment = result.fulfillment ?? { status: 'pending' };
      out.result.dueAt = result.outcome === 'sold' ? result.at + rules.payment.dueHours * 3600_000 : null;
      if (isWinner && rules.payment.instructions) out.result.instructions = rules.payment.instructions;
    }
  }
  return out;
}

/** The public projection pushed to /public/auction/{aid}. */
export const publicState = (rules, state, result) => viewState(ANONYMOUS, rules, state, result);

/**
 * One bid row for this viewer, or null if the viewer may not see it.
 * sealedOpen: amounts stay hidden from everyone (pending bids aside, which the
 * owner must see to approve) until the item closes.
 */
export function viewBid(viewer, rules, bid, masks, { sealedOpen = false } = {}) {
  const mine = viewer.uid != null && bid.uid === viewer.uid;
  if (viewer.owner) {
    const showMax = bid.status === 'pending' || rules.proxy.hostSeesMax;
    return {
      id: bid.bidId,
      bidder: who(viewer, rules, bid.uid, bid.tag),
      amount: sealedOpen && bid.status !== 'pending' ? null : bid.amount,
      max: showMax ? bid.max ?? null : null,
      status: bid.status,
      kind: bid.kind,
      placedAt: bid.placedAt,
      acceptedAt: bid.acceptedAt ?? null,
      decidedAt: bid.decidedAt ?? null,
      decidedBy: bid.decidedBy ?? null,
      originalAmount: bid.originalAmount ?? null,
      reason: bid.reason ?? null,
      enteredBy: bid.enteredBy ?? null,
    };
  }
  if (mine) {
    return {
      id: bid.bidId,
      bidder: { you: true, label: 'You' },
      amount: bid.amount,
      max: bid.max ?? null,
      status: bid.status,
      kind: bid.kind,
      placedAt: bid.placedAt,
      acceptedAt: bid.acceptedAt ?? null,
      originalAmount: bid.originalAmount ?? null,
      reason: bid.reason ?? null,
    };
  }
  if (bid.status !== 'accepted' || sealedOpen || !canSee(viewer, rules, 'history')) return null;
  return {
    id: bid.bidId,
    bidder: who(viewer, rules, bid.uid, bid.tag, masks.get(bid.uid)),
    amount: canSee(viewer, rules, 'historyAmounts') ? bid.amount : null,
    status: bid.status,
    placedAt: bid.placedAt,
  };
}

/**
 * The shared standings table, one row per bidder. The leader shows at the
 * current price; everyone else at the highest amount they reached (their
 * maximum, which is spent once they are outbid). Returns null if hidden.
 */
export function board(viewer, rules, state, bids) {
  const cfg = rules.board;
  // Sealed standings stay hidden from everyone until the item closes.
  if (isSealed(rules) && state.status !== 'closed') return null;
  if (!viewer.owner) {
    if (!cfg.enabled || !allowed(viewer, cfg.audience)) return null;
    if (cfg.when === 'after_close' && state.status !== 'closed') return null;
  }
  const masks = maskMap(bids);
  const down = rules.format === 'reverse';
  const best = new Map();
  const order = bids.filter((b) => b.status === 'accepted').sort((a, b) => a.acceptedAt - b.acceptedAt);
  for (const b of order) {
    // english: the highest a bidder reached (maximum included); reverse: their
    // lowest; sealed: their latest bid, which replaced the earlier ones.
    const reached = down || isSealed(rules) ? b.amount : Math.max(b.amount, b.max ?? 0);
    const row = best.get(b.uid);
    if (!row) best.set(b.uid, { uid: b.uid, tag: b.tag, amount: reached, at: b.acceptedAt, bids: 1 });
    else {
      row.bids += 1;
      const better = isSealed(rules) || (down ? reached < row.amount : reached > row.amount);
      if (better) Object.assign(row, { amount: reached, at: b.acceptedAt });
    }
  }
  const rows = [...best.values()].map((r) => {
    if (r.uid !== state.leaderId) return r;
    return { ...r, amount: isSealed(rules) ? r.amount : state.price, leading: true };
  });
  rows.sort((a, b) => (b.leading ? 1 : 0) - (a.leading ? 1 : 0) || (down ? a.amount - b.amount : b.amount - a.amount) || a.at - b.at);

  const columns = viewer.owner ? ['rank', 'bidder', 'amount', 'time', 'status', 'bids'] : cfg.columns;
  const seeAmounts = canSee(viewer, rules, 'historyAmounts');
  const seeLeader = canSee(viewer, rules, 'leader');
  return {
    columns,
    rows: rows.map((r, i) => {
      const mine = r.uid === viewer.uid;
      const row = { you: mine };
      for (const c of columns) {
        if (c === 'rank') row.rank = i + 1;
        if (c === 'bidder') row.bidder = who(viewer, rules, r.uid, r.tag, masks.get(r.uid));
        if (c === 'amount') row.amount = seeAmounts || mine ? r.amount : null;
        if (c === 'time') row.time = r.at;
        if (c === 'status') row.status = seeLeader || mine ? (r.leading ? 'leading' : 'outbid') : null;
        if (c === 'bids') row.bids = r.bids;
      }
      return row;
    }),
  };
}

/** One chat message for this viewer. */
export function viewChat(viewer, rules, msg) {
  const mine = viewer.uid != null && msg.uid === viewer.uid;
  let author;
  if (mine) author = 'You';
  else if (msg.role === 'host') author = 'Host';
  else author = label(viewer.owner ? 'name' : rules.chat.identity, msg.tag, 'Bidder');
  const out = {
    id: msg.id,
    at: msg.at,
    role: msg.role,
    author,
    mine,
    text: msg.deleted ? null : msg.text,
    deleted: !!msg.deleted,
  };
  if (viewer.owner) Object.assign(out, { uid: msg.uid, alias: msg.tag?.alias, paddle: msg.tag?.paddle });
  return out;
}

/** Auction rules as a non-owner may see them (the reserve can be secret). */
export function viewRules(viewer, rules) {
  if (viewer.owner) return rules;
  const out = structuredClone(rules);
  if (!canSee(viewer, rules, 'reserveAmount')) out.price.reserve = rules.price.reserve == null ? null : 'hidden';
  delete out.proxy.hostSeesMax;
  out.access = { mode: rules.access.mode }; // never the code or the invite list
  return out;
}
