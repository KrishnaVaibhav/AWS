// The rules engine. Pure functions only (no I/O), so the API, the closer and
// the tests all run the same code. Amounts are whole units (dollars, credits):
// no fractions, so no rounding drift.

import { badRequest } from './http.mjs';

export const MAX_AMOUNT = 1_000_000_000_000;

export const FORMATS = ['english', 'sealed_first', 'sealed_second', 'dutch', 'reverse', 'fixed_price'];

export const DEFAULT_RULES = Object.freeze({
  // english       ascending bids, proxy, soft close
  // sealed_first  hidden bids, highest pays what they bid
  // sealed_second hidden bids, highest pays the second-highest bid (Vickrey)
  // dutch         the price falls on a clock; the first to accept buys
  // reverse       descending bids, lowest wins (procurement); reserve = budget ceiling
  // fixed_price   a listing: buy at the price, or make an offer
  format: 'english',
  timing: {
    opensAt: null,            // ISO time; null = as soon as the auction is published
    closesAt: null,           // ISO time; required before publishing (here or per item)
    staggerSec: 0,            // item N closes N × staggerSec after closesAt
    softClose: { windowSec: 120, extendSec: 120, maxExtensions: 30 },
  },
  price: {
    currency: 'USD',
    start: 1,                 // english/sealed: opening bid; reverse: ceiling; fixed_price: the price
    reserve: null,
    buyNow: { amount: null, until: 'first_bid' },             // english only; until first_bid | reserve_met | close
    dutch: { start: null, step: 1, everySec: 60, floor: 1 },  // dutch: falls by step every everySec, down to floor
    offers: { enabled: false, autoAccept: null, autoDecline: null }, // fixed_price: offers at or over autoAccept are accepted, under autoDecline declined
  },
  increment: {
    mode: 'fixed',            // fixed | percent | tiered | bidder_choice
    fixed: 1,
    percent: 5,
    roundTo: 1,
    tiers: [{ upTo: 100, step: 5 }, { upTo: 1000, step: 25 }, { upTo: null, step: 100 }],
    bidderChoice: { min: 1, max: null, presets: [1, 5, 10] },
    confirmAbovePct: 50,      // a bid this far above the minimum needs confirmed: true; 0 = off
  },
  proxy: { enabled: true, hostSeesMax: false },
  registration: 'auto',       // auto | approval
  bidApproval: {
    mode: 'none',             // none | above | all
    threshold: 0,             // mode above: bids (or maximums) at or over this wait for the owner
    adjust: 'lower',          // none | lower | any: may the owner change the amount when approving?
    decideWithinSec: 900,     // pending bids can still be decided this long after the close
    onTimeout: 'reject',      // reject | approve: what happens to undecided bids at that deadline
  },
  balance: {
    enabled: false,           // bidders spend a balance the owner credits and debits
    enforce: true,            // refuse bids the bidder's available balance can't cover
    unit: 'credits',
    allowNegative: false,     // may the owner debit below zero?
    startingCredit: 0,        // credited when a registration is approved
    showToBidder: true,
  },
  limits: { bidLimit: null }, // default per-bidder cap; the owner can set one per bidder
  visibility: {
    price: 'public',
    bidCount: 'public',
    nextMin: 'public',
    closesAt: 'public',
    leader: 'registered',            // is someone winning, and who (masked unless historyIdentities)
    history: 'registered',           // the bid list
    historyAmounts: 'registered',    // amounts in the bid list and board
    historyIdentities: 'owner',      // real aliases/paddles instead of "Bidder 1, 2, 3"
    reserveAmount: 'owner',
    reserveStatus: 'public',         // "reserve met / not met"
    participants: 'owner',           // the list of registered bidders
  },
  identity: 'alias',          // alias | paddle | name: how a revealed bidder is shown
  board: {
    enabled: true,            // the shared standings table
    audience: 'registered',
    when: 'always',           // always | after_close
    columns: ['rank', 'bidder', 'amount', 'time', 'status'],
  },
  chat: {
    enabled: true,
    read: 'registered',
    post: 'approved',
    identity: 'alias',        // alias | paddle | name
    slowModeSec: 2,
    maxLength: 500,
    hostOnly: false,          // announcements only: bidders read, only the owner posts
  },
  conduct: { hostCanBid: false },
  access: {
    mode: 'public',           // public = listed | unlisted = link only | code = access code or invite needed
    code: null,
    invites: [],              // emails that may join a code auction without the code
  },
  payment: { instructions: '', dueHours: 72 }, // shown to winners; payment is settled offline
});

// Who may see a field. group:<name> = approved bidders the owner put in that group.
export const AUDIENCE = /^(public|registered|approved|owner|group:[a-z0-9-]{1,24})$/;
export const BOARD_COLUMNS = ['rank', 'bidder', 'amount', 'time', 'status', 'bids'];

// Keys an item may override; everything else comes from the auction.
const ITEM_OVERRIDABLE = ['format', 'price', 'increment', 'proxy', 'bidApproval', 'timing'];

export class RuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ── Config ────────────────────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects merge, arrays and scalars replace, null clears. */
export function mergeRules(base, patch) {
  if (patch === undefined) return base;
  if (!isObject(patch) || !isObject(base)) return structuredClone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(base[k]) ? mergeRules(base[k], v) : structuredClone(v);
  }
  return out;
}

/** Effective rules for one item: auction rules + the item's overrides. */
export function effectiveRules(auctionRules, overrides) {
  return overrides ? mergeRules(auctionRules, overrides) : auctionRules;
}

function fail(path, message) {
  throw badRequest('invalid_rules', `${path}: ${message}`, { path });
}

function checkKeys(obj, template, path) {
  if (!isObject(obj)) fail(path || 'rules', 'must be an object');
  for (const key of Object.keys(obj)) {
    if (!(key in template)) fail(path ? `${path}.${key}` : key, 'unknown setting');
    if (isObject(template[key])) checkKeys(obj[key], template[key], path ? `${path}.${key}` : key);
  }
}

const isInt = (v, min = 0, max = MAX_AMOUNT) => Number.isSafeInteger(v) && v >= min && v <= max;

function intAt(path, v, min = 0, max = MAX_AMOUNT) {
  if (!isInt(v, min, max)) fail(path, `must be a whole number from ${min} to ${max}`);
}

function boolAt(path, v) {
  if (typeof v !== 'boolean') fail(path, 'must be true or false');
}

function enumAt(path, v, options) {
  if (!options.includes(v)) fail(path, `must be one of ${options.join(', ')}`);
}

function audienceAt(path, v) {
  if (typeof v !== 'string' || !AUDIENCE.test(v)) {
    fail(path, 'must be public, registered, approved, owner or group:<name>');
  }
}

function timeAt(path, v) {
  if (v === null) return;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(path, 'must be an ISO date-time or null');
}

/** Throws a 400 for any bad or unknown setting. Expects merged (complete) rules. */
export function validateRules(r) {
  checkKeys(r, DEFAULT_RULES, '');
  enumAt('format', r.format, FORMATS);

  const t = r.timing;
  timeAt('timing.opensAt', t.opensAt);
  timeAt('timing.closesAt', t.closesAt);
  if (t.opensAt && t.closesAt && Date.parse(t.closesAt) <= Date.parse(t.opensAt)) {
    fail('timing.closesAt', 'must be after opensAt');
  }
  intAt('timing.staggerSec', t.staggerSec, 0, 3600);
  intAt('timing.softClose.windowSec', t.softClose.windowSec, 0, 3600);
  intAt('timing.softClose.extendSec', t.softClose.extendSec, 0, 3600);
  intAt('timing.softClose.maxExtensions', t.softClose.maxExtensions, 0, 1000);

  if (typeof r.price.currency !== 'string' || !/^[A-Z]{3,10}$/.test(r.price.currency)) {
    fail('price.currency', 'must be 3-10 capital letters, e.g. USD or CREDITS');
  }
  intAt('price.start', r.price.start, 1);
  if (r.price.reserve !== null) intAt('price.reserve', r.price.reserve, 1);
  const bn = r.price.buyNow;
  if (bn.amount !== null) {
    intAt('price.buyNow.amount', bn.amount, r.price.start);
    if (r.format !== 'english') fail('price.buyNow.amount', 'Buy It Now is for english auctions (fixed_price sells at price.start)');
  }
  enumAt('price.buyNow.until', bn.until, ['first_bid', 'reserve_met', 'close']);
  const d = r.price.dutch;
  intAt('price.dutch.step', d.step, 1);
  intAt('price.dutch.everySec', d.everySec, 1, 86400);
  intAt('price.dutch.floor', d.floor, 1);
  if (d.start !== null) intAt('price.dutch.start', d.start, d.floor + 1);
  if (r.format === 'dutch' && d.start === null) fail('price.dutch.start', 'is required for a dutch auction');
  const of = r.price.offers;
  boolAt('price.offers.enabled', of.enabled);
  if (of.autoAccept !== null) intAt('price.offers.autoAccept', of.autoAccept, 1);
  if (of.autoDecline !== null) intAt('price.offers.autoDecline', of.autoDecline, 1);
  if (of.autoAccept !== null && of.autoDecline !== null && of.autoDecline > of.autoAccept) {
    fail('price.offers.autoDecline', 'must not be above autoAccept');
  }
  if (of.enabled && r.format !== 'fixed_price') fail('price.offers.enabled', 'offers are for fixed_price listings');

  const inc = r.increment;
  enumAt('increment.mode', inc.mode, ['fixed', 'percent', 'tiered', 'bidder_choice']);
  intAt('increment.fixed', inc.fixed, 1);
  intAt('increment.percent', inc.percent, 1, 100);
  intAt('increment.roundTo', inc.roundTo, 1);
  intAt('increment.confirmAbovePct', inc.confirmAbovePct, 0, 10000);
  if (!Array.isArray(inc.tiers) || inc.tiers.length < 1 || inc.tiers.length > 20) {
    fail('increment.tiers', 'must list 1-20 tiers');
  }
  inc.tiers.forEach((tier, i) => {
    const path = `increment.tiers[${i}]`;
    if (!isObject(tier)) fail(path, 'must be { upTo, step }');
    checkKeys(tier, { upTo: 0, step: 0 }, path);
    intAt(`${path}.step`, tier.step, 1);
    const last = i === inc.tiers.length - 1;
    if (last ? tier.upTo != null : !isInt(tier.upTo, 1)) {
      fail(`${path}.upTo`, last ? 'must be null on the last tier' : 'must be a whole number');
    }
    if (i > 0 && !last && tier.upTo <= inc.tiers[i - 1].upTo) fail(`${path}.upTo`, 'must go up');
  });
  const choice = inc.bidderChoice;
  intAt('increment.bidderChoice.min', choice.min, 1);
  if (choice.max !== null) intAt('increment.bidderChoice.max', choice.max, choice.min);
  if (!Array.isArray(choice.presets) || choice.presets.length > 6) {
    fail('increment.bidderChoice.presets', 'must be a list of up to 6 amounts');
  }
  choice.presets.forEach((p, i) => intAt(`increment.bidderChoice.presets[${i}]`, p, choice.min, choice.max ?? MAX_AMOUNT));

  boolAt('proxy.enabled', r.proxy.enabled);
  boolAt('proxy.hostSeesMax', r.proxy.hostSeesMax);
  enumAt('registration', r.registration, ['auto', 'approval']);

  const ap = r.bidApproval;
  enumAt('bidApproval.mode', ap.mode, ['none', 'above', 'all']);
  intAt('bidApproval.threshold', ap.threshold, 0);
  enumAt('bidApproval.adjust', ap.adjust, ['none', 'lower', 'any']);
  intAt('bidApproval.decideWithinSec', ap.decideWithinSec, 0, 7 * 86400);
  enumAt('bidApproval.onTimeout', ap.onTimeout, ['reject', 'approve']);

  const bal = r.balance;
  for (const k of ['enabled', 'enforce', 'allowNegative', 'showToBidder']) boolAt(`balance.${k}`, bal[k]);
  if (typeof bal.unit !== 'string' || bal.unit.length < 1 || bal.unit.length > 16) fail('balance.unit', 'must be 1-16 characters');
  intAt('balance.startingCredit', bal.startingCredit, 0);

  if (r.limits.bidLimit !== null) intAt('limits.bidLimit', r.limits.bidLimit, 1);

  for (const [k, v] of Object.entries(r.visibility)) audienceAt(`visibility.${k}`, v);
  enumAt('identity', r.identity, ['alias', 'paddle', 'name']);

  boolAt('board.enabled', r.board.enabled);
  audienceAt('board.audience', r.board.audience);
  enumAt('board.when', r.board.when, ['always', 'after_close']);
  if (!Array.isArray(r.board.columns) || r.board.columns.length < 1
      || r.board.columns.some((c) => !BOARD_COLUMNS.includes(c))) {
    fail('board.columns', `must be a non-empty list from ${BOARD_COLUMNS.join(', ')}`);
  }

  const chat = r.chat;
  boolAt('chat.enabled', chat.enabled);
  boolAt('chat.hostOnly', chat.hostOnly);
  audienceAt('chat.read', chat.read);
  audienceAt('chat.post', chat.post);
  enumAt('chat.identity', chat.identity, ['alias', 'paddle', 'name']);
  intAt('chat.slowModeSec', chat.slowModeSec, 0, 3600);
  intAt('chat.maxLength', chat.maxLength, 1, 2000);

  boolAt('conduct.hostCanBid', r.conduct.hostCanBid);

  const acc = r.access;
  enumAt('access.mode', acc.mode, ['public', 'unlisted', 'code']);
  if (acc.code !== null && (typeof acc.code !== 'string' || !/^[\x21-\x7e]{4,64}$/.test(acc.code))) {
    fail('access.code', 'must be 4-64 visible characters, or null');
  }
  if (!Array.isArray(acc.invites) || acc.invites.length > 500
      || acc.invites.some((e) => typeof e !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > 254)) {
    fail('access.invites', 'must be a list of up to 500 email addresses');
  }
  if (acc.mode === 'code' && acc.code === null && !acc.invites.length) fail('access.code', 'set a code or invites for mode code');

  if (typeof r.payment.instructions !== 'string' || r.payment.instructions.length > 2000) {
    fail('payment.instructions', 'must be text up to 2000 characters');
  }
  intAt('payment.dueHours', r.payment.dueHours, 0, 8760);

  // Combinations that don't make sense.
  if ((r.format === 'dutch' || r.format === 'fixed_price') && r.bidApproval.mode !== 'none') {
    fail('bidApproval.mode', `must be none for ${r.format}: the first buyer wins at once`);
  }
  if (r.format === 'reverse' && r.balance.enabled) fail('balance.enabled', 'balances are for buyers; reverse auctions pay the winner');
  return r;
}

/** Item overrides: only some sections, and the merged result must validate. */
export function validateOverrides(auctionRules, overrides) {
  if (overrides == null) return null;
  if (!isObject(overrides)) fail('overrides', 'must be an object');
  for (const key of Object.keys(overrides)) {
    if (!ITEM_OVERRIDABLE.includes(key)) fail(`overrides.${key}`, `items can only override ${ITEM_OVERRIDABLE.join(', ')}`);
  }
  if (overrides.timing) {
    for (const key of Object.keys(overrides.timing)) {
      if (!['opensAt', 'closesAt'].includes(key)) fail(`overrides.timing.${key}`, 'items can only override opensAt and closesAt');
    }
  }
  validateRules(mergeRules(auctionRules, overrides));
  return overrides;
}

// ── Prices ────────────────────────────────────────────────────────────

const roundUp = (x, to) => Math.ceil(x / to) * to;

/** The step above a given price. */
export function increment(price, inc) {
  switch (inc.mode) {
    case 'fixed':
      return inc.fixed;
    case 'percent':
      return Math.max(roundUp((price * inc.percent) / 100, inc.roundTo), inc.roundTo);
    case 'tiered':
      return (inc.tiers.find((t) => t.upTo == null || price < t.upTo) ?? inc.tiers.at(-1)).step;
    case 'bidder_choice':
      return inc.bidderChoice.min;
    default:
      throw new Error(`unknown increment mode ${inc.mode}`);
  }
}

export const isProxy = (rules) => rules.proxy.enabled && rules.format === 'english';
export const isSealed = (rules) => rules.format === 'sealed_first' || rules.format === 'sealed_second';

/**
 * The next allowed bid: the lowest for english and sealed, the highest for
 * reverse (bids go down). Dutch prices come from dutchPrice instead.
 */
export function nextMin(state, rules) {
  if (rules.format === 'english') {
    return state.bidCount > 0 ? state.price + increment(state.price, rules.increment) : rules.price.start;
  }
  if (rules.format === 'reverse') {
    return state.bidCount > 0 ? state.price - increment(state.price, rules.increment) : rules.price.start;
  }
  if (rules.format === 'dutch') return rules.price.dutch.start;
  return rules.price.start;
}

/** Dutch: the price at `now`, falling step by step from the opening time. */
export function dutchPrice(rules, state, now) {
  const d = rules.price.dutch;
  const steps = Math.max(0, Math.floor((now - state.opensAt) / (d.everySec * 1000)));
  return Math.max(d.floor, d.start - steps * d.step);
}

/** Dutch: when the price drops next, or null once it sits at the floor. */
export function nextDutchDrop(rules, state, now) {
  const d = rules.price.dutch;
  if (dutchPrice(rules, state, now) <= d.floor) return null;
  const steps = Math.max(0, Math.floor((now - state.opensAt) / (d.everySec * 1000)));
  return state.opensAt + (steps + 1) * d.everySec * 1000;
}

/** Price a buyer pays to end the item now, or null if buying outright isn't open. */
export function buyNowPrice(state, rules) {
  if (state.status !== 'open') return null;
  if (rules.format === 'fixed_price') return rules.price.start;
  const { amount, until } = rules.price.buyNow;
  if (rules.format !== 'english' || amount == null) return null;
  if (state.price >= amount) return null;
  const firstBidOnly = until === 'first_bid' || (until === 'reserve_met' && rules.price.reserve == null);
  if (firstBidOnly && (state.bidCount > 0 || (state.pendingCount ?? 0) > 0)) return null;
  if (until === 'reserve_met' && state.reserveMet && state.bidCount > 0) return null;
  return amount;
}

/** fixed_price offers: what the thresholds decide on their own. */
export function offerVerdict(rules, amount) {
  const { autoAccept, autoDecline } = rules.price.offers;
  if (amount >= rules.price.start || (autoAccept != null && amount >= autoAccept)) return 'accept';
  if (autoDecline != null && amount < autoDecline) return 'decline';
  return 'pending';
}

/** english and reverse: the outcome at close. */
export function closeOutcome(state) {
  if (!state.leaderId) return 'no_bids';
  return state.reserveMet ? 'sold' : 'reserve_not_met';
}

/**
 * Sealed bids at close (one per bidder): highest wins, earliest on a tie.
 * First-price pays the bid; second-price pays the second-highest bid, but at
 * least the start price and the reserve, and never more than the winner bid.
 */
export function sealedResult(rules, bids) {
  const ranked = [...bids].sort((a, b) => b.amount - a.amount || a.placedAt - b.placedAt);
  const top = ranked[0];
  const reserve = rules.price.reserve;
  if (!top) return { outcome: 'no_bids', ranked };
  if (reserve != null && top.amount < reserve) return { outcome: 'reserve_not_met', ranked };
  const price = rules.format === 'sealed_second'
    ? Math.min(top.amount, Math.max(ranked[1]?.amount ?? 0, rules.price.start, reserve ?? 0))
    : top.amount;
  return { outcome: 'sold', winner: top, price, ranked };
}

/** The highest bid allowed now, or null for no ceiling (bidder_choice only). */
export function maxRaise(state, rules) {
  const choice = rules.increment.bidderChoice;
  if (rules.format !== 'english' || rules.increment.mode !== 'bidder_choice' || choice.max == null || state.bidCount === 0) return null;
  return state.price + choice.max;
}

export function initialState(rules, { opensAt, closesAt }) {
  const reserve = rules.price.reserve;
  return {
    status: 'open',
    opensAt,
    closesAt,
    price: 0,
    bidCount: 0,
    leaderId: null,
    leaderMax: 0,
    leaderHold: 0,
    leaderTag: null,
    extensions: 0,
    pendingCount: 0,
    nextMin: nextMin({ bidCount: 0, price: 0 }, rules),
    hasReserve: reserve != null,
    reserveMet: reserve == null,
  };
}

/**
 * Proxy-bid arithmetic only, no checks. A new maximum M against the leader's
 * maximum Ml: if M > Ml the newcomer leads at min(M, Ml + step), else the
 * leader stays at min(Ml, M + step); a tie goes to the earlier bid. A
 * maximum that reaches the reserve lifts the price to the reserve.
 */
export function applyBid(state, rules, bid) {
  if (rules.format === 'reverse') return applyReverse(state, rules, bid);
  const { uid, amount, max } = bid;
  const proxy = isProxy(rules);
  const M = proxy ? Math.max(amount, max ?? amount) : amount;
  const reserve = rules.price.reserve;
  const s = { ...state };
  let outcome;

  if (!state.leaderId) {
    Object.assign(s, { leaderId: uid, leaderMax: M, price: amount, bidCount: state.bidCount + 1 });
    outcome = 'leading';
  } else if (state.leaderId === uid) {
    s.leaderMax = Math.max(state.leaderMax, M);
    if (!proxy) {
      s.price = Math.max(state.price, amount);
      s.bidCount = state.bidCount + 1;
    }
    outcome = 'raised_max';
  } else if (M > state.leaderMax) {
    const Ml = state.leaderMax;
    s.price = Math.max(amount, Math.min(M, Ml + increment(Ml, rules.increment)));
    Object.assign(s, { leaderId: uid, leaderMax: M, bidCount: state.bidCount + 1 });
    outcome = 'leading';
  } else {
    const Ml = state.leaderMax;
    const counter = M === Ml ? Ml : Math.min(Ml, M + increment(M, rules.increment));
    s.price = Math.max(state.price, counter);
    s.bidCount = state.bidCount + 1;
    outcome = 'outbid';
  }

  if (reserve != null && s.leaderMax >= reserve && s.price < reserve) s.price = reserve;
  s.hasReserve = reserve != null;
  s.reserveMet = reserve == null || (s.leaderId != null && s.price >= reserve);
  s.nextMin = nextMin(s, rules);
  return { state: s, outcome };
}

/** Reverse: the lowest bid leads. No proxy; the reserve is the budget ceiling. */
function applyReverse(state, rules, { uid, amount }) {
  const reserve = rules.price.reserve;
  const s = { ...state, bidCount: state.bidCount + 1 };
  let outcome = 'outbid';
  if (!state.leaderId || amount < state.price) {
    Object.assign(s, { leaderId: uid, leaderMax: amount, price: amount });
    outcome = 'leading';
  }
  s.hasReserve = reserve != null;
  s.reserveMet = reserve == null || (s.leaderId != null && s.price <= reserve);
  s.nextMin = nextMin(s, rules);
  return { state: s, outcome };
}

/** Would this bid wait for the owner? Owner-entered bids never do. */
export function needsApproval(rules, { amount, max }, { onBehalf = false } = {}) {
  if (onBehalf) return false;
  const { mode, threshold } = rules.bidApproval;
  if (mode === 'all') return true;
  if (mode === 'above') return Math.max(amount, max ?? 0) >= threshold;
  return false;
}

/**
 * Checks a bid against the rules and returns the new state.
 *   placedAt   when the bidder sent it (pending bids keep their original time)
 *   approving  the owner is approving a pending bid, which is allowed until
 *              closesAt + decideWithinSec as long as the bid was placed in time
 */
export function evaluateBid(state, rules, bid, now, { placedAt = now, approving = false } = {}) {
  if (state.status !== 'open') throw new RuleError('item_closed', 'Bidding on this item is over');
  if (placedAt < state.opensAt) throw new RuleError('not_open_yet', 'Bidding has not started', { opensAt: state.opensAt });
  const graceUntil = state.closesAt + rules.bidApproval.decideWithinSec * 1000;
  if (placedAt >= state.closesAt || (now >= state.closesAt && !(approving && now <= graceUntil))) {
    throw new RuleError('item_closed', 'Bidding on this item is over');
  }

  const { amount, max } = bid;
  if (!isInt(amount, 1)) throw new RuleError('bad_amount', 'Amount must be a whole number above 0');
  if (rules.format === 'fixed_price') throw new RuleError('use_buy', 'This is a fixed-price listing: buy it or make an offer');
  if (max != null) {
    if (!isProxy(rules)) throw new RuleError('proxy_disabled', 'Maximum bids are off for this item');
    if (!isInt(max, 1)) throw new RuleError('bad_amount', 'Maximum must be a whole number above 0');
    if (max < amount) throw new RuleError('max_below_amount', 'Maximum must be at least the bid amount');
  }

  if (rules.format === 'dutch') {
    // The first to accept buys at the current price, whatever the clock says now.
    const current = dutchPrice(rules, state, now);
    if (state.leaderId) throw new RuleError('item_closed', 'Someone already bought this item');
    if (amount < current) throw new RuleError('below_min', `The price is now ${current}`, { nextMin: current });
    return {
      state: { ...state, leaderId: bid.uid, leaderMax: current, price: current, bidCount: 1, reserveMet: true },
      outcome: 'won',
    };
  }

  if (isSealed(rules)) {
    // One hidden bid per bidder; a new one replaces the old. No soft close.
    if (amount < rules.price.start) throw new RuleError('below_min', `The minimum bid is ${rules.price.start}`, { nextMin: rules.price.start });
    return { state: { ...state, bidCount: state.bidCount + (bid.replacing ? 0 : 1) }, outcome: bid.replacing ? 'replaced' : 'sealed' };
  }

  const min = nextMin(state, rules);
  const pct = rules.increment.confirmAbovePct;
  if (rules.format === 'reverse') {
    if (state.leaderId === bid.uid) throw new RuleError('already_leading', 'You already have the lowest bid');
    if (min < 1) throw new RuleError('no_lower_bid', 'The price cannot go any lower');
    if (amount > min) throw new RuleError('above_max', `The highest bid allowed now is ${min}`, { nextMin: min });
    if (pct > 0 && !bid.confirmed && !approving && amount < min * (1 - Math.min(pct, 99) / 100)) {
      throw new RuleError('confirm_required', `That is far below the limit of ${min}. Send confirmed: true to place it.`, { nextMin: min });
    }
  } else if (state.leaderId === bid.uid) {
    if (!rules.proxy.enabled) throw new RuleError('already_leading', 'You already have the highest bid');
    if (Math.max(amount, max ?? amount) <= state.leaderMax) {
      throw new RuleError('max_not_higher', 'You are already winning; a new maximum must be higher than your current one');
    }
  } else {
    if (amount < min) throw new RuleError('below_min', `The minimum bid is ${min}`, { nextMin: min });
    const ceiling = maxRaise(state, rules);
    if (ceiling != null && amount > ceiling) {
      throw new RuleError('raise_too_big', `The highest bid allowed now is ${ceiling}`, { maxBid: ceiling });
    }
    if (pct > 0 && !bid.confirmed && !approving && amount > min * (1 + pct / 100)) {
      throw new RuleError('confirm_required', `That is far above the minimum of ${min}. Send confirmed: true to place it.`, { nextMin: min });
    }
  }

  const { state: next, outcome } = applyBid(state, rules, bid);
  const sc = rules.timing.softClose;
  if (outcome !== 'raised_max' && now < state.closesAt && sc.windowSec > 0
      && state.closesAt - now <= sc.windowSec * 1000 && state.extensions < sc.maxExtensions) {
    next.closesAt = Math.max(state.closesAt, now + sc.extendSec * 1000);
    next.extensions = state.extensions + 1;
  }
  return { state: next, outcome };
}

/**
 * Rebuilds price and leader from the accepted bids, in the order they were
 * accepted. Used after the owner cancels a bid. No timing checks; the close
 * time and extensions stay as they are.
 */
export function replay(state, rules, acceptedBids) {
  let s = {
    ...state,
    price: 0,
    bidCount: 0,
    leaderId: null,
    leaderMax: 0,
    leaderTag: null,
    nextMin: nextMin({ bidCount: 0, price: 0 }, rules),
    hasReserve: rules.price.reserve != null,
    reserveMet: rules.price.reserve == null,
  };
  const order = [...acceptedBids].sort((a, b) => a.acceptedAt - b.acceptedAt || (a.bidId < b.bidId ? -1 : 1));
  for (const b of order) s = applyBid(s, rules, b).state;
  return s;
}
