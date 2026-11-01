// Pure rules engine and visibility tests. No AWS, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULES, mergeRules, validateRules, validateOverrides, increment, nextMin,
  initialState, applyBid, evaluateBid, needsApproval, replay, RuleError,
} from '../functions/lib/rules.mjs';
import { ANONYMOUS, canSee, viewState, board, viewBid, maskMap, viewChat, viewRules } from '../functions/lib/visibility.mjs';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const rulesWith = (patch) => validateRules(mergeRules(DEFAULT_RULES, patch));
const open = (rules, extra = {}) => ({ ...initialState(rules, { opensAt: T0, closesAt: T0 + 3_600_000 }), version: 1, ...extra });

test('defaults validate; unknown and bad settings are rejected', () => {
  validateRules(mergeRules(DEFAULT_RULES, {}));
  assert.throws(() => rulesWith({ nope: 1 }), /nope: unknown setting/);
  assert.throws(() => rulesWith({ chat: { read: 'everyone' } }), /chat.read/);
  assert.throws(() => rulesWith({ increment: { tiers: [{ upTo: 10, step: 1 }] } }), /null on the last tier/);
  assert.throws(() => rulesWith({ price: { start: 1.5 } }), /price.start/);
  rulesWith({ visibility: { leader: 'group:vip' } });
});

test('item overrides are limited to price, increment, proxy, approval and close times', () => {
  validateOverrides(DEFAULT_RULES, { price: { start: 50 }, timing: { closesAt: '2030-01-02T00:00:00Z' } });
  assert.throws(() => validateOverrides(DEFAULT_RULES, { chat: { enabled: false } }), /items can only override/);
  assert.throws(() => validateOverrides(DEFAULT_RULES, { timing: { staggerSec: 5 } }), /opensAt and closesAt/);
});

test('increments: fixed, percent, tiered, bidder choice', () => {
  const inc = DEFAULT_RULES.increment;
  assert.equal(increment(100, { ...inc, mode: 'fixed', fixed: 7 }), 7);
  assert.equal(increment(101, { ...inc, mode: 'percent', percent: 5, roundTo: 1 }), 6);
  assert.equal(increment(99, { ...inc, mode: 'tiered' }), 5);
  assert.equal(increment(100, { ...inc, mode: 'tiered' }), 25);
  assert.equal(increment(5000, { ...inc, mode: 'tiered' }), 100);
  assert.equal(increment(5000, { ...inc, mode: 'bidder_choice' }), 1);
});

test('first bid sets the price; proxy keeps the leader at one step above the challenger', () => {
  const rules = rulesWith({ price: { start: 10 }, increment: { fixed: 5, confirmAbovePct: 0 } });
  let s = open(rules);
  assert.equal(nextMin(s, rules), 10);
  s = evaluateBid(s, rules, { uid: 'a', amount: 10, max: 100 }, T0 + 1).state;
  assert.deepEqual([s.price, s.leaderId, s.leaderMax, s.nextMin], [10, 'a', 100, 15]);

  const r = evaluateBid(s, rules, { uid: 'b', amount: 50 }, T0 + 2);
  assert.equal(r.outcome, 'outbid');
  assert.deepEqual([r.state.price, r.state.leaderId], [55, 'a']);

  const r2 = evaluateBid(r.state, rules, { uid: 'b', amount: 60, max: 200 }, T0 + 3);
  assert.equal(r2.outcome, 'leading');
  assert.deepEqual([r2.state.price, r2.state.leaderId, r2.state.leaderMax], [105, 'b', 200]);
});

test('a tie goes to the earlier maximum', () => {
  const rules = rulesWith({ increment: { fixed: 5, confirmAbovePct: 0 } });
  let s = evaluateBid(open(rules), rules, { uid: 'a', amount: 1, max: 100 }, T0 + 1).state;
  s = evaluateBid(s, rules, { uid: 'b', amount: 100 }, T0 + 2).state;
  assert.deepEqual([s.leaderId, s.price], ['a', 100]);
});

test('a maximum that reaches the reserve lifts the price to it', () => {
  const rules = rulesWith({ price: { start: 10, reserve: 80 }, increment: { confirmAbovePct: 0 } });
  const s = evaluateBid(open(rules), rules, { uid: 'a', amount: 10, max: 90 }, T0 + 1).state;
  assert.deepEqual([s.price, s.reserveMet], [80, true]);
  const low = evaluateBid(open(rules), rules, { uid: 'a', amount: 10, max: 50 }, T0 + 1).state;
  assert.deepEqual([low.price, low.reserveMet], [10, false]);
});

test('bid checks: minimum, timing, leader, fat finger, bidder choice ceiling', () => {
  const rules = rulesWith({ price: { start: 10 }, increment: { fixed: 5 } });
  const s = open(rules);
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof RuleError); return e.code; } return 'ok'; };
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 9 }, T0 + 1)), 'below_min');
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 10 }, T0 - 1)), 'not_open_yet');
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 10 }, T0 + 3_600_000)), 'item_closed');
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 16 }, T0 + 1)), 'confirm_required');
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 16, confirmed: true }, T0 + 1)), 'ok');
  const led = evaluateBid(s, rules, { uid: 'a', amount: 10, max: 20 }, T0 + 1).state;
  assert.equal(code(() => evaluateBid(led, rules, { uid: 'a', amount: 15, max: 20 }, T0 + 2)), 'max_not_higher');
  assert.equal(code(() => evaluateBid(led, rules, { uid: 'a', amount: 15, max: 30 }, T0 + 2)), 'ok');

  const choice = rulesWith({ increment: { mode: 'bidder_choice', bidderChoice: { min: 5, max: 50, presets: [5, 10] }, confirmAbovePct: 0 } });
  const c = evaluateBid(open(choice), choice, { uid: 'a', amount: 1 }, T0 + 1).state;
  assert.equal(c.nextMin, 6);
  assert.equal(code(() => evaluateBid(c, choice, { uid: 'b', amount: 52 }, T0 + 2)), 'raise_too_big');
  assert.equal(code(() => evaluateBid(c, choice, { uid: 'b', amount: 51 }, T0 + 2)), 'ok');
});

test('soft close extends a bid placed in the last window', () => {
  const rules = rulesWith({ timing: { softClose: { windowSec: 120, extendSec: 120, maxExtensions: 1 } } });
  const s = open(rules);
  const late = T0 + 3_600_000 - 30_000;
  const r = evaluateBid(s, rules, { uid: 'a', amount: 1 }, late).state;
  assert.equal(r.closesAt, late + 120_000);
  assert.equal(r.extensions, 1);
  const r2 = evaluateBid(r, rules, { uid: 'b', amount: 2 }, r.closesAt - 10_000).state;
  assert.equal(r2.closesAt, r.closesAt); // maxExtensions reached
});

test('approval rules and the decision grace period', () => {
  const rules = rulesWith({ bidApproval: { mode: 'above', threshold: 100, decideWithinSec: 600 } });
  assert.equal(needsApproval(rules, { amount: 50 }), false);
  assert.equal(needsApproval(rules, { amount: 50, max: 100 }), true);
  assert.equal(needsApproval(rules, { amount: 500 }, { onBehalf: true }), false);
  const s = open(rules);
  const closesAt = s.closesAt;
  // placed before the close, approved after it: fine inside the grace period
  evaluateBid(s, rules, { uid: 'a', amount: 1 }, closesAt + 1000, { placedAt: closesAt - 1000, approving: true });
  assert.throws(() => evaluateBid(s, rules, { uid: 'a', amount: 1 }, closesAt + 601_000, { placedAt: closesAt - 1000, approving: true }), /over/);
  assert.throws(() => evaluateBid(s, rules, { uid: 'a', amount: 1 }, closesAt + 1000), /over/);
});

test('replay without a cancelled bid rebuilds price and leader', () => {
  const rules = rulesWith({ increment: { fixed: 5, confirmAbovePct: 0 } });
  const bids = [
    { bidId: '1', uid: 'a', amount: 1, max: 50, acceptedAt: 1 },
    { bidId: '2', uid: 'b', amount: 60, acceptedAt: 2 },
  ];
  const full = replay(open(rules), rules, bids);
  assert.deepEqual([full.leaderId, full.price], ['b', 60]);
  const without = replay(full, rules, bids.slice(0, 1));
  assert.deepEqual([without.leaderId, without.price, without.bidCount], ['a', 1, 1]);
});

// ── Visibility ────────────────────────────────────────────────────────

const reg = (status, extra = {}) => ({ uid: 'me', status, alias: 'Me', paddle: 3, groups: [], see: {}, ...extra });

test('audiences and per-bidder overrides', () => {
  const rules = rulesWith({ visibility: { leader: 'approved', price: 'registered', reserveAmount: 'group:vip' } });
  const pending = { uid: 'me', owner: false, reg: reg('pending') };
  const approved = { uid: 'me', owner: false, reg: reg('approved') };
  const vip = { uid: 'me', owner: false, reg: reg('approved', { groups: ['vip'] }) };
  const blocked = { uid: 'me', owner: false, reg: reg('blocked', { see: { price: true } }) };
  assert.equal(canSee(ANONYMOUS, rules, 'price'), false);
  assert.equal(canSee(pending, rules, 'price'), true);
  assert.equal(canSee(pending, rules, 'leader'), false);
  assert.equal(canSee(approved, rules, 'leader'), true);
  assert.equal(canSee(approved, rules, 'reserveAmount'), false);
  assert.equal(canSee(vip, rules, 'reserveAmount'), true);
  assert.equal(canSee(blocked, rules, 'price'), false);
  const hidden = { uid: 'me', owner: false, reg: reg('approved', { see: { leader: false, reserveAmount: true } }) };
  assert.equal(canSee(hidden, rules, 'leader'), false);
  assert.equal(canSee(hidden, rules, 'reserveAmount'), true);
  assert.equal(canSee({ uid: 'o', owner: true, reg: null }, rules, 'reserveAmount'), true);
});

test('item state hides what the viewer may not see', () => {
  const rules = rulesWith({ price: { reserve: 100 }, visibility: { price: 'approved', leader: 'public' } });
  const s = { ...open(rules), price: 40, bidCount: 2, leaderId: 'x', leaderMax: 70, leaderTag: { alias: 'Xavier', paddle: 9 } };
  const anon = viewState(ANONYMOUS, rules, s);
  assert.equal(anon.price, null);
  assert.equal(anon.reserve.amount, null);
  assert.equal(anon.reserve.met, false);
  assert.equal(anon.leader.label, 'Another bidder'); // identities hidden by default
  const owner = viewState({ uid: 'o', owner: true, reg: null }, rules, s);
  assert.equal(owner.price, 40);
  assert.equal(owner.reserve.amount, 100);
  assert.equal(owner.leaderMax, null); // hostSeesMax off
  const leader = viewState({ uid: 'x', owner: false, reg: reg('approved', { uid: 'x' }) }, rules, s);
  assert.deepEqual(leader.you, { leading: true, max: 70, sealedBid: null });
  assert.equal(viewRules(ANONYMOUS, rules).price.reserve, 'hidden');
});

test('board: leader at price, others at what they reached, columns and masks applied', () => {
  const rules = rulesWith({ board: { audience: 'public', columns: ['rank', 'bidder', 'amount'] }, visibility: { historyAmounts: 'public' } });
  const s = { ...open(rules), price: 60, leaderId: 'b', leaderMax: 200 };
  const bids = [
    { bidId: '1', uid: 'a', amount: 10, max: 50, status: 'accepted', acceptedAt: 1, tag: { alias: 'A' } },
    { bidId: '2', uid: 'b', amount: 60, max: 200, status: 'accepted', acceptedAt: 2, tag: { alias: 'B' } },
    { bidId: '3', uid: 'c', amount: 999, status: 'pending', placedAt: 3, tag: { alias: 'C' } },
  ];
  const b = board(ANONYMOUS, rules, s, bids);
  assert.deepEqual(b.columns, ['rank', 'bidder', 'amount']);
  assert.deepEqual(b.rows.map((r) => [r.rank, r.bidder.label, r.amount]), [[1, 'Bidder 2', 60], [2, 'Bidder 1', 50]]);
  assert.equal(b.rows[0].status, undefined);
  const off = rulesWith({ board: { enabled: false } });
  assert.equal(board(ANONYMOUS, off, s, bids), null);
  assert.equal(board({ uid: 'o', owner: true, reg: null }, off, s, bids).rows.length, 2);
  const after = rulesWith({ board: { audience: 'public', when: 'after_close' } });
  assert.equal(board(ANONYMOUS, after, s, bids), null);
});

test('bid list: own bids in full, others masked, pending hidden', () => {
  const rules = rulesWith({ visibility: { history: 'public', historyAmounts: 'owner' } });
  const bids = [
    { bidId: '1', uid: 'a', amount: 10, max: 50, status: 'accepted', acceptedAt: 1, placedAt: 1 },
    { bidId: '2', uid: 'me', amount: 20, max: 30, status: 'pending', placedAt: 2 },
    { bidId: '3', uid: 'c', amount: 25, status: 'pending', placedAt: 3 },
  ];
  const masks = maskMap(bids);
  const me = { uid: 'me', owner: false, reg: reg('approved') };
  const seen = bids.map((b) => viewBid(me, rules, b, masks)).filter(Boolean);
  assert.equal(seen.length, 2);
  assert.deepEqual([seen[0].bidder.label, seen[0].amount], ['Bidder 1', null]);
  assert.deepEqual([seen[1].status, seen[1].max], ['pending', 30]);
  const owner = viewBid({ uid: 'o', owner: true, reg: null }, rules, bids[0], masks);
  assert.equal(owner.max, null); // accepted maximum stays private
  assert.equal(viewBid({ uid: 'o', owner: true, reg: null }, rules, bids[2], masks).amount, 25);
});

test('chat view: host label, identity style, deleted text', () => {
  const rules = rulesWith({ chat: { identity: 'paddle' } });
  const msg = { id: '1', uid: 'a', role: 'bidder', tag: { alias: 'A', paddle: 7, name: 'Ann' }, text: 'hi', at: 1 };
  assert.equal(viewChat(ANONYMOUS, rules, msg).author, 'Paddle 7');
  assert.equal(viewChat({ uid: 'o', owner: true, reg: null }, rules, msg).author, 'Ann');
  assert.equal(viewChat(ANONYMOUS, rules, { ...msg, role: 'host' }).author, 'Host');
  assert.equal(viewChat(ANONYMOUS, rules, { ...msg, deleted: true }).text, null);
});
