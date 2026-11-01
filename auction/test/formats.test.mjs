// Pure tests for the phase 2 engine pieces, Web Push crypto and CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createHmac, createPublicKey, verify } from 'node:crypto';
import {
  DEFAULT_RULES, mergeRules, validateRules, initialState, evaluateBid, sealedResult, dutchPrice,
  nextDutchDrop, buyNowPrice, offerVerdict, replay, RuleError,
} from '../functions/lib/rules.mjs';
import { ANONYMOUS, viewState, board } from '../functions/lib/visibility.mjs';
import { encrypt, vapidHeader, validEndpoint } from '../functions/lib/webpush.mjs';
import { parseCsv, csvObjects } from '../functions/lib/csv.mjs';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const rulesWith = (patch) => validateRules(mergeRules(DEFAULT_RULES, patch));
const open = (rules) => ({ ...initialState(rules, { opensAt: T0, closesAt: T0 + 3_600_000 }), version: 1 });
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof RuleError, e.message); return e.code; } return 'ok'; };
const OWNER = { uid: 'o', owner: true, reg: null };

test('combinations are validated', () => {
  assert.throws(() => rulesWith({ format: 'dutch' }), /price.dutch.start/);
  assert.throws(() => rulesWith({ format: 'dutch', price: { dutch: { start: 100 } }, bidApproval: { mode: 'all' } }), /bidApproval.mode/);
  assert.throws(() => rulesWith({ price: { offers: { enabled: true } } }), /fixed_price/);
  assert.throws(() => rulesWith({ format: 'reverse', balance: { enabled: true } }), /balance.enabled/);
  assert.throws(() => rulesWith({ format: 'sealed_first', price: { buyNow: { amount: 50 } } }), /english/);
  assert.throws(() => rulesWith({ access: { mode: 'code' } }), /access.code/);
  assert.throws(() => rulesWith({ access: { invites: ['not-an-email'] } }), /access.invites/);
  rulesWith({ access: { mode: 'code', code: 'OPEN-SESAME' } });
  rulesWith({ format: 'fixed_price', price: { start: 100, offers: { enabled: true, autoAccept: 90, autoDecline: 50 } } });
});

test('sealed: one hidden bid per bidder, replaced not added; first and second price', () => {
  const rules = rulesWith({ format: 'sealed_first', price: { start: 10 } });
  const s = open(rules);
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 9 }, T0 + 1)), 'below_min');
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 20, max: 30 }, T0 + 1)), 'proxy_disabled');
  const one = evaluateBid(s, rules, { uid: 'a', amount: 50 }, T0 + 1).state;
  assert.equal(one.bidCount, 1);
  assert.equal(evaluateBid(one, rules, { uid: 'a', amount: 40, replacing: true }, T0 + 2).state.bidCount, 1);

  const bids = [{ uid: 'a', amount: 50, placedAt: 1 }, { uid: 'b', amount: 80, placedAt: 2 }, { uid: 'c', amount: 80, placedAt: 3 }];
  assert.deepEqual([sealedResult(rules, bids).winner.uid, sealedResult(rules, bids).price], ['b', 80]);
  const second = rulesWith({ format: 'sealed_second', price: { start: 10, reserve: 60 } });
  assert.equal(sealedResult(second, [{ uid: 'a', amount: 50, placedAt: 1 }, { uid: 'b', amount: 90, placedAt: 2 }]).price, 60, 'at least the reserve');
  assert.equal(sealedResult(second, [{ uid: 'a', amount: 75, placedAt: 1 }, { uid: 'b', amount: 90, placedAt: 2 }]).price, 75);
  assert.equal(sealedResult(second, [{ uid: 'a', amount: 59, placedAt: 1 }]).outcome, 'reserve_not_met');
  assert.equal(sealedResult(second, []).outcome, 'no_bids');
});

test('sealed: nobody, the owner included, sees price, leader or standings while open', () => {
  const rules = rulesWith({ format: 'sealed_second', board: { audience: 'public' } });
  const s = { ...open(rules), bidCount: 2, price: 0 };
  const v = viewState(OWNER, rules, s, null, { sealed: { amount: 70 } });
  assert.deepEqual([v.price, v.leader, v.reserve.met], [null, null, null]);
  assert.equal(v.bidCount, 2);
  assert.equal(viewState({ uid: 'a', owner: false, reg: null }, rules, s, null, { sealed: { amount: 70 } }).you.sealedBid, 70);
  assert.equal(board(OWNER, rules, s, [{ uid: 'a', amount: 70, status: 'accepted', acceptedAt: 1 }]), null);
});

test('dutch: the clock lowers the price to the floor; the first acceptance wins', () => {
  const rules = rulesWith({ format: 'dutch', price: { dutch: { start: 100, step: 10, everySec: 60, floor: 55 } } });
  const s = open(rules);
  assert.equal(dutchPrice(rules, s, T0), 100);
  assert.equal(dutchPrice(rules, s, T0 + 125_000), 80);
  assert.equal(dutchPrice(rules, s, T0 + 3_000_000), 55);
  assert.equal(nextDutchDrop(rules, s, T0 + 125_000), T0 + 180_000);
  assert.equal(nextDutchDrop(rules, s, T0 + 3_000_000), null);
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 79 }, T0 + 125_000)), 'below_min');
  const won = evaluateBid(s, rules, { uid: 'a', amount: 100 }, T0 + 125_000);
  assert.deepEqual([won.outcome, won.state.price, won.state.leaderId], ['won', 80, 'a']);
  assert.equal(code(() => evaluateBid(won.state, rules, { uid: 'b', amount: 100 }, T0 + 126_000)), 'item_closed');
  assert.equal(viewState(ANONYMOUS, rules, s, null, {}, T0 + 125_000).price, 80);
});

test('reverse: lowest leads, limit falls by the increment, reserve is the budget', () => {
  const rules = rulesWith({ format: 'reverse', price: { start: 1000, reserve: 800 }, increment: { fixed: 50, confirmAbovePct: 0 } });
  let s = open(rules);
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 1001 }, T0 + 1)), 'above_max');
  s = evaluateBid(s, rules, { uid: 'a', amount: 950 }, T0 + 1).state;
  assert.deepEqual([s.leaderId, s.price, s.nextMin, s.reserveMet], ['a', 950, 900, false]);
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'a', amount: 900 }, T0 + 2)), 'already_leading');
  assert.equal(code(() => evaluateBid(s, rules, { uid: 'b', amount: 901 }, T0 + 2)), 'above_max');
  s = evaluateBid(s, rules, { uid: 'b', amount: 800 }, T0 + 2).state;
  assert.deepEqual([s.leaderId, s.reserveMet], ['b', true]);
  const back = replay(s, rules, [{ bidId: '1', uid: 'a', amount: 950, acceptedAt: 1 }]);
  assert.deepEqual([back.leaderId, back.price], ['a', 950]);
  const v = viewState(ANONYMOUS, rules, s);
  assert.equal(v.direction, 'down');
});

test('Buy It Now availability and offer thresholds', () => {
  const firstBid = rulesWith({ price: { start: 10, buyNow: { amount: 100, until: 'first_bid' } } });
  const s = open(firstBid);
  assert.equal(buyNowPrice(s, firstBid), 100);
  assert.equal(buyNowPrice({ ...s, bidCount: 1, price: 10 }, firstBid), null);
  const untilClose = rulesWith({ price: { start: 10, buyNow: { amount: 100, until: 'close' } } });
  assert.equal(buyNowPrice({ ...s, bidCount: 3, price: 60 }, untilClose), 100);
  assert.equal(buyNowPrice({ ...s, bidCount: 3, price: 100 }, untilClose), null);
  const untilReserve = rulesWith({ price: { start: 10, reserve: 50, buyNow: { amount: 100, until: 'reserve_met' } } });
  assert.equal(buyNowPrice({ ...s, bidCount: 1, price: 20, reserveMet: false }, untilReserve), 100);
  assert.equal(buyNowPrice({ ...s, bidCount: 2, price: 50, reserveMet: true }, untilReserve), null);
  const fixed = rulesWith({ format: 'fixed_price', price: { start: 200, offers: { enabled: true, autoAccept: 180, autoDecline: 100 } } });
  assert.equal(buyNowPrice(open(fixed), fixed), 200);
  assert.equal(code(() => evaluateBid(open(fixed), fixed, { uid: 'a', amount: 200 }, T0 + 1)), 'use_buy');
  assert.deepEqual([90, 150, 180, 250].map((a) => offerVerdict(fixed, a)), ['decline', 'pending', 'accept', 'accept']);
});

test('Web Push: aes128gcm payload decrypts on the browser side; VAPID JWT verifies', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const body = encrypt('{"title":"hi"}', ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
  // Browser side (RFC 8291 section 3.4), written independently of encrypt().
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const h = (k, d) => createHmac('sha256', k).update(d).digest();
  const ikm = h(h(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = h(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const record = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'last-record padding delimiter');
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"hi"}');

  const ec = createECDH('prime256v1');
  ec.generateKeys();
  const pub = ec.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url'), d: ec.getPrivateKey().toString('base64url') };
  const header = vapidHeader('https://fcm.googleapis.com/fcm/send/x', { privateJwk: jwk, publicKey: pub.toString('base64url') }, 'mailto:a@b.org');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  const [hd, cl, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(cl, 'base64url')).aud, 'https://fcm.googleapis.com');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(k, pub.toString('base64url'));
  assert.equal(validEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(validEndpoint('https://web.push.apple.com/x'), true);
  assert.equal(validEndpoint('https://evil.example/fcm.googleapis.com'), false);
  assert.equal(validEndpoint('http://fcm.googleapis.com/x'), false);
});

test('CSV: quotes, doubled quotes, CRLF, header objects', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(csvObjects('﻿Title,Start\nLamp,10\n\n'), [{ title: 'Lamp', start: '10' }]);
});
