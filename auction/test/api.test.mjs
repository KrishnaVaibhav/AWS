// End-to-end API tests against DynamoDB Local (npm run dynamodb, or the
// service container in CI). Skipped when nothing listens on DYNAMODB_ENDPOINT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
Object.assign(process.env, {
  DYNAMODB_ENDPOINT: ENDPOINT,
  TABLE_NAME: `auction-test-${Date.now()}`,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  STAGE: 'test',
});
delete process.env.EVENTS_HTTP;
delete process.env.SCHEDULE_GROUP;

const reachable = await fetch(ENDPOINT).then(() => true, () => false);
if (!reachable && process.env.REQUIRE_DYNAMODB) throw new Error(`REQUIRE_DYNAMODB is set but nothing answers at ${ENDPOINT}`);

test('auction API end to end', { skip: !reachable && `no DynamoDB Local at ${ENDPOINT}` }, async (t) => {
  const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = await import('@aws-sdk/client-dynamodb');
  const { handler } = await import('../functions/api/index.mjs');
  const { useTestKeys } = await import('../functions/lib/auth.mjs');
  const { closeItem, sweepOverdue } = await import('../functions/lib/auction.mjs');

  const ddb = new DynamoDBClient({ endpoint: ENDPOINT });
  const S = (n) => ({ AttributeName: n, AttributeType: 'S' });
  const gsi = (n) => ({ IndexName: n, KeySchema: [{ AttributeName: `${n}PK`, KeyType: 'HASH' }, { AttributeName: `${n}SK`, KeyType: 'RANGE' }], Projection: { ProjectionType: 'KEYS_ONLY' } });
  await ddb.send(new CreateTableCommand({
    TableName: process.env.TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map(S),
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [gsi('GSI1'), gsi('GSI2')],
  }));
  t.after(() => ddb.send(new DeleteTableCommand({ TableName: process.env.TABLE_NAME })));

  // Sign ID tokens with a local key the API is told to trust.
  const issuer = 'https://issuer.test/pool';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  useTestKeys(issuer, [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }]);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenFor = (u) => {
    const unsigned = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({
      sub: u.uid, email: `${u.name}@test`, name: u.name, iss: issuer, token_use: 'id', exp: Math.floor(Date.now() / 1000) + 3600,
    })}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
  };
  const users = Object.fromEntries(['owner', 'alice', 'bob', 'carol'].map((name) => [name, { uid: randomUUID(), name }]));

  async function call(method, path, { as, body, qs } = {}) {
    const res = await handler({
      requestContext: { http: { method } },
      rawPath: path,
      queryStringParameters: qs,
      headers: as ? { 'x-auth-token': tokenFor(users[as]) } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = res.headers['content-type'].startsWith('application/json') ? JSON.parse(res.body) : res.body;
    return { status: res.statusCode, body: parsed };
  }
  const ok = async (expected, promise) => {
    const res = await promise;
    assert.equal(res.status, expected, JSON.stringify(res.body));
    return res.body;
  };

  const closesAt = Date.now() + 3_600_000;
  let aid;
  let item1;
  let item2;

  await t.test('anyone can read the rule defaults the settings forms are built from', async () => {
    const out = await ok(200, call('GET', '/api/rules/defaults'));
    assert.equal(out.rules.format, 'english');
    assert.ok(out.formats.includes('sealed_second'));
    assert.ok(out.boardColumns.includes('rank'));
  });

  await t.test('owner creates a draft auction with custom rules and items', async () => {
    assert.equal((await call('POST', '/api/auctions', { body: { title: 'x' } })).status, 401);
    const bad = await call('POST', '/api/auctions', { as: 'owner', body: { title: 'x', rules: { chat: { read: 'all' } } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_rules');

    const { auction } = await ok(201, call('POST', '/api/auctions', {
      as: 'owner',
      body: {
        title: 'Estate sale',
        rules: {
          timing: { closesAt: new Date(closesAt).toISOString(), staggerSec: 60 },
          price: { start: 10 },
          increment: { fixed: 5, confirmAbovePct: 0 },
          registration: 'approval',
          bidApproval: { mode: 'above', threshold: 80, adjust: 'lower' },
          balance: { enabled: true, startingCredit: 100 },
          visibility: { leader: 'approved' },
          chat: { read: 'registered', post: 'approved', slowModeSec: 5 },
        },
      },
    }));
    aid = auction.id;
    assert.equal(auction.status, 'draft');
    item1 = (await ok(201, call('POST', `/api/auctions/${aid}/items`, { as: 'owner', body: { title: 'Lamp', fields: { condition: 'good' } } }))).item.id;
    item2 = (await ok(201, call('POST', `/api/auctions/${aid}/items`, { as: 'owner', body: { title: 'Vase', overrides: { price: { reserve: 50 } } } }))).item.id;
    assert.equal((await call('GET', `/api/auctions/${aid}`)).status, 404, 'drafts are hidden');
    assert.equal((await call('POST', `/api/auctions/${aid}/items`, { as: 'alice', body: { title: 'x' } })).status, 404, 'a draft does not exist for others');
  });

  await t.test('publishing opens every item with staggered close times', async () => {
    await ok(200, call('POST', `/api/auctions/${aid}/publish`, { as: 'owner' }));
    const { items } = await ok(200, call('GET', `/api/auctions/${aid}/items`));
    assert.deepEqual(items.map((i) => i.state.status), ['open', 'open']);
    assert.equal(items[1].state.closesAt - items[0].state.closesAt, 60_000);
    assert.equal(items[1].state.reserve.amount, null, 'reserve amount is owner-only');
    const live = await ok(200, call('GET', '/api/auctions'));
    assert.ok(live.auctions.some((a) => a.id === aid));
  });

  await t.test('registration approval and starting credit', async () => {
    const reg = await ok(201, call('POST', `/api/auctions/${aid}/register`, { as: 'alice', body: { alias: 'Al' } }));
    assert.equal(reg.registration.status, 'pending');
    const blocked = await call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice', body: { amount: 10 } });
    assert.equal(blocked.status, 403);
    await ok(200, call('PATCH', `/api/auctions/${aid}/registrations/${users.alice.uid}`, { as: 'owner', body: { status: 'approved' } }));
    await ok(201, call('POST', `/api/auctions/${aid}/register`, { as: 'bob' }));
    await ok(200, call('PATCH', `/api/auctions/${aid}/registrations/${users.bob.uid}`, { as: 'owner', body: { status: 'approved' } }));
    const { auction } = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'alice' }));
    assert.deepEqual(auction.balance, { ...auction.balance, balance: 100, available: 100, committed: 0 });
    // approving twice must not credit twice
    await ok(200, call('PATCH', `/api/auctions/${aid}/registrations/${users.alice.uid}`, { as: 'owner', body: { status: 'pending' } }));
    await ok(200, call('PATCH', `/api/auctions/${aid}/registrations/${users.alice.uid}`, { as: 'owner', body: { status: 'approved' } }));
    const again = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'alice' }));
    assert.equal(again.auction.balance.balance, 100);
  });

  await t.test('proxy bidding with balance holds', async () => {
    const first = await ok(201, call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice', body: { amount: 10, max: 40 } }));
    assert.equal(first.outcome, 'leading');
    const bob = await ok(201, call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'bob', body: { amount: 30 } }));
    assert.equal(bob.outcome, 'outbid');
    assert.equal(bob.item.state.price, 35);
    const low = await call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'bob', body: { amount: 36 } });
    assert.equal(low.body.error, 'below_min');
    assert.equal(low.body.nextMin, 40);
    const { auction } = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'alice' }));
    assert.deepEqual([auction.balance.available, auction.balance.committed], [60, 40]);
  });

  await t.test('big bids wait for the owner; the owner may lower them', async () => {
    const pending = await ok(202, call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'bob', body: { amount: 100 } }));
    assert.equal(pending.status, 'pending');
    const queue = await ok(200, call('GET', `/api/auctions/${aid}/pending`, { as: 'owner' }));
    assert.equal(queue.pending.length, 1);
    assert.equal((await call('GET', `/api/auctions/${aid}/pending`, { as: 'bob' })).status, 403);
    const raise = await call('POST', `/api/auctions/${aid}/items/${item1}/bids/${pending.bidId}/decision`, { as: 'owner', body: { approve: true, amount: 120 } });
    assert.equal(raise.status, 403, 'adjust=lower forbids raising');
    const done = await ok(200, call('POST', `/api/auctions/${aid}/items/${item1}/bids/${pending.bidId}/decision`, { as: 'owner', body: { approve: true, amount: 90 } }));
    assert.equal(done.outcome, 'leading');
    const again = await call('POST', `/api/auctions/${aid}/items/${item1}/bids/${pending.bidId}/decision`, { as: 'owner', body: { approve: true } });
    assert.equal(again.body.error, 'already_decided');
    const { item } = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}`, { as: 'owner' }));
    assert.equal(item.state.price, 90);
    assert.equal(item.state.leader.uid, users.bob.uid);
    const alice = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'alice' }));
    assert.deepEqual([alice.auction.balance.available, alice.auction.balance.committed], [100, 0], 'outbid hold released');
  });

  await t.test('owner credits balances; bids the balance cannot cover are refused', async () => {
    const poor = await call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice', body: { amount: 95, max: 200 } });
    assert.equal(poor.body.error, 'insufficient_balance');
    assert.equal((await call('POST', `/api/auctions/${aid}/balances/${users.alice.uid}`, { as: 'alice', body: { delta: 500, reason: 'x' } })).status, 403);
    const credited = await ok(200, call('POST', `/api/auctions/${aid}/balances/${users.alice.uid}`, { as: 'owner', body: { delta: 150, reason: 'Wire received' } }));
    assert.equal(credited.balance.balance, 250);
    const tooMuch = await call('POST', `/api/auctions/${aid}/balances/${users.bob.uid}`, { as: 'owner', body: { delta: -50, reason: 'x' } });
    assert.equal(tooMuch.body.error, 'insufficient_balance', 'bob has 90 of 100 held');
    const pending = await ok(202, call('POST', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice', body: { amount: 95, max: 200 } }));
    await ok(200, call('POST', `/api/auctions/${aid}/items/${item1}/bids/${pending.bidId}/decision`, { as: 'owner', body: { approve: false, reason: 'Too high' } }));
    const { bids } = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice' }));
    const mine = bids.find((b) => b.id === pending.bidId);
    assert.deepEqual([mine.status, mine.reason], ['rejected', 'Too high']);
  });

  await t.test('visibility: masks, per-field audiences, per-bidder overrides, board', async () => {
    const anon = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}`));
    assert.equal(anon.item.state.price, 90);
    assert.equal(anon.item.state.leader, null, 'leader is approved-only');
    const alice = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}`, { as: 'alice' }));
    assert.equal(alice.item.state.leader.label, 'Another bidder');

    const carolBids = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'carol' }));
    assert.deepEqual([carolBids.historyVisible, carolBids.bids.length], [false, 0]);
    const aliceBids = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice' }));
    const bobRow = aliceBids.bids.find((b) => b.bidder.label.startsWith('Bidder'));
    assert.ok(bobRow, 'other bidders are masked');
    const ownerBids = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'owner' }));
    assert.ok(ownerBids.bids.every((b) => b.bidder.uid), 'owner sees who');
    assert.ok(ownerBids.bids.some((b) => b.status === 'rejected'));
    assert.ok(ownerBids.bids.some((b) => b.originalAmount === 100));

    const board = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/board`, { as: 'alice' }));
    assert.deepEqual(board.board.rows.map((r) => [r.rank, r.amount, r.you]), [[1, 90, false], [2, 40, true]]);
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/board`))).board, null);

    await ok(200, call('PATCH', `/api/auctions/${aid}/registrations/${users.alice.uid}`, { as: 'owner', body: { see: { leader: false, historyIdentities: true } } }));
    const hidden = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}`, { as: 'alice' }));
    assert.equal(hidden.item.state.leader, null);
    const revealed = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'alice' }));
    assert.ok(revealed.bids.some((b) => b.bidder.label === 'Bidder 2'), 'bob kept the default alias');

    await ok(200, call('PATCH', `/api/auctions/${aid}`, { as: 'owner', body: { rules: { board: { enabled: false } } } }));
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/board`, { as: 'alice' }))).board, null);
    assert.ok((await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/board`, { as: 'owner' }))).board);
    const locked = await call('PATCH', `/api/auctions/${aid}`, { as: 'owner', body: { rules: { timing: { staggerSec: 0 } } } });
    assert.equal(locked.body.error, 'locked');
  });

  await t.test('live chat: audiences, slow mode, mute, delete', async () => {
    assert.equal((await call('POST', `/api/auctions/${aid}/chat`, { as: 'carol', body: { text: 'hi' } })).status, 403);
    await ok(201, call('POST', `/api/auctions/${aid}/chat`, { as: 'alice', body: { text: 'Is the lamp wired?' } }));
    const slow = await call('POST', `/api/auctions/${aid}/chat`, { as: 'alice', body: { text: 'hello?' } });
    assert.deepEqual([slow.status, slow.body.error], [409, 'slow_mode']);
    const host = await ok(201, call('POST', `/api/auctions/${aid}/chat`, { as: 'owner', body: { text: 'Yes, rewired in 2020.' } }));
    assert.equal(host.message.role, 'host');

    assert.equal((await call('GET', `/api/auctions/${aid}/chat`, { as: 'carol' })).status, 403);
    const bobView = await ok(200, call('GET', `/api/auctions/${aid}/chat`, { as: 'bob' }));
    assert.deepEqual(bobView.messages.map((m) => m.author), ['Al', 'Host']);
    assert.equal(bobView.canPost, true);
    const after = await ok(200, call('GET', `/api/auctions/${aid}/chat`, { as: 'bob', qs: { after: bobView.messages[0].id } }));
    assert.equal(after.messages.length, 1);

    await ok(200, call('PATCH', `/api/auctions/${aid}/registrations/${users.bob.uid}`, { as: 'owner', body: { muted: true } }));
    assert.equal((await call('POST', `/api/auctions/${aid}/chat`, { as: 'bob', body: { text: 'hey' } })).status, 403);
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}/chat`, { as: 'bob' }))).canPost, false);

    const first = bobView.messages[0].id;
    assert.equal((await call('DELETE', `/api/auctions/${aid}/chat/${first}`, { as: 'bob' })).status, 403);
    await ok(200, call('DELETE', `/api/auctions/${aid}/chat/${first}`, { as: 'owner' }));
    const cleaned = await ok(200, call('GET', `/api/auctions/${aid}/chat`, { as: 'alice' }));
    assert.deepEqual([cleaned.messages[0].deleted, cleaned.messages[0].text], [true, null]);

    await ok(200, call('PATCH', `/api/auctions/${aid}`, { as: 'owner', body: { rules: { chat: { hostOnly: true } } } }));
    await new Promise((r) => setTimeout(r, 5100)); // past alice's slow mode
    assert.equal((await call('POST', `/api/auctions/${aid}/chat`, { as: 'alice', body: { text: 'x' } })).status, 403);
    await ok(200, call('PATCH', `/api/auctions/${aid}`, { as: 'owner', body: { rules: { chat: { hostOnly: false } } } }));
  });

  await t.test('owner cancels a bid; price, leader and holds are rebuilt', async () => {
    const { bids } = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}/bids`, { as: 'owner' }));
    const bobWin = bids.find((b) => b.bidder.uid === users.bob.uid && b.status === 'accepted' && b.amount === 90);
    await ok(200, call('POST', `/api/auctions/${aid}/items/${item1}/bids/${bobWin.id}/cancel`, { as: 'owner', body: { reason: 'Shill suspicion' } }));
    const { item } = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}`, { as: 'owner' }));
    assert.equal(item.state.leader.uid, users.alice.uid);
    assert.equal(item.state.price, 35, 'alice leads at one step over bob\'s 30');
    const regs = await ok(200, call('GET', `/api/auctions/${aid}/registrations`, { as: 'owner' }));
    const bal = (u) => regs.registrations.find((r) => r.uid === users[u].uid).balance;
    assert.deepEqual([bal('bob').committed, bal('alice').committed], [0, 40]);
  });

  await t.test('closing: pending bids get the grace period, then the winner is charged', async () => {
    const pending = await ok(202, call('POST', `/api/auctions/${aid}/items/${item2}/bids`, { as: 'bob', body: { amount: 80 } }));
    const state2 = (await ok(200, call('GET', `/api/auctions/${aid}/items/${item2}`, { as: 'owner' }))).item.state;
    assert.equal(state2.pendingCount, 1);

    const early = await closeItem(item1, { now: closesAt - 1000, reschedule: false });
    assert.equal(early.result, 'not_due');
    const sold = await closeItem(item1, { now: closesAt + 1000, reschedule: false });
    assert.deepEqual([sold.result, sold.price], ['sold', 35]);
    const won = await ok(200, call('GET', `/api/auctions/${aid}/items/${item1}`, { as: 'alice' }));
    assert.deepEqual([won.item.state.status, won.item.state.result.outcome, won.item.state.result.winner.you], ['closed', 'sold', true]);
    const alice = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'alice' }));
    assert.deepEqual([alice.auction.balance.balance, alice.auction.balance.committed, alice.auction.balance.available], [215, 0, 215]);

    const close2 = closesAt + 60_000;
    const wait = await closeItem(item2, { now: close2 + 1000, reschedule: false });
    assert.equal(wait.result, 'waiting_for_decisions');
    const swept = await sweepOverdue(close2 + 901_000);
    assert.deepEqual(swept.map((r) => r.result), ['no_bids']);
    const { bids } = await ok(200, call('GET', `/api/auctions/${aid}/items/${item2}/bids`, { as: 'bob' }));
    assert.equal(bids.find((b) => b.id === pending.bidId).status, 'rejected');
    const { auction } = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'owner' }));
    assert.equal(auction.status, 'ended');
  });

  await t.test('history, ledger and CSV export', async () => {
    const { entries } = await ok(200, call('GET', `/api/auctions/${aid}/history`, { as: 'owner' }));
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['auction.created', 'auction.published', 'registration.updated', 'balance.adjusted',
      'bid.approved', 'bid.rejected', 'bid.cancelled', 'chat.deleted', 'auction.updated', 'item.closed']) {
      assert.ok(actions.has(a), `history has ${a}`);
    }
    assert.equal((await call('GET', `/api/auctions/${aid}/history`, { as: 'alice' })).status, 403);
    const ledger = await ok(200, call('GET', `/api/auctions/${aid}/ledger`, { as: 'alice' }));
    assert.deepEqual(ledger.entries.map((e) => [e.type, e.delta]).sort(), [['charge', -35], ['credit', 100], ['credit', 150]]);
    const exported = await ok(200, call('GET', `/api/auctions/${aid}/export`, { as: 'owner', qs: { type: 'bids' } }));
    assert.match(exported, /^item,lot,bidId/);
    assert.equal(exported.split('\r\n').length, 6); // header + 5 bids
  });

  await t.test('stream turns changes into public and personal events', async () => {
    const { marshall } = await import('@aws-sdk/util-dynamodb');
    const { put, keys } = await import('../functions/lib/db.mjs');
    const { DEFAULT_RULES, mergeRules } = await import('../functions/lib/rules.mjs');
    const { handler } = await import('../functions/stream/index.mjs');
    const aid = randomUUID();
    const iid = randomUUID();
    await put({ ...keys.auction(aid), aid, hostId: 'host', rules: mergeRules(DEFAULT_RULES, { visibility: { leader: 'public' } }) }).catch(() => {});

    const sent = [];
    const realFetch = globalThis.fetch;
    process.env.EVENTS_HTTP = 'events.test';
    globalThis.fetch = async (url, init) => { sent.push({ url, ...JSON.parse(init.body) }); return new Response('{}'); };
    try {
      const img = (o) => marshall(o, { removeUndefinedValues: true });
      const base = { ...keys.state(iid), iid, aid, status: 'open', price: 10, bidCount: 1, nextMin: 11, opensAt: 0, closesAt: 9e12, extensions: 0, hasReserve: false, reserveMet: true, version: 2, pendingCount: 0 };
      await handler({
        Records: [
          { eventName: 'MODIFY', dynamodb: { OldImage: img({ ...base, leaderId: 'u1', version: 1 }), NewImage: img({ ...base, leaderId: 'u2', leaderMax: 4242421 }) } },
          { eventName: 'INSERT', dynamodb: { NewImage: img({ ...keys.chat(aid, 'm1'), aid, id: 'm1', uid: 'u1', role: 'bidder', text: 'secret', at: 1 }) } },
        ],
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.EVENTS_HTTP;
    }
    const events = sent.flatMap((s) => s.events.map((e) => ({ channel: s.channel, ...JSON.parse(e) })));
    const item = events.find((e) => e.type === 'item');
    assert.equal(item.channel, `/public/auction/${aid}`);
    assert.equal(item.state.price, 10);
    assert.equal(JSON.stringify(item).includes('4242421'), false, 'the leader maximum never goes out');
    assert.ok(events.some((e) => e.channel === '/user/u1' && e.type === 'outbid'));
    const chat = events.find((e) => e.type === 'chat_ping');
    assert.ok(chat, 'members-only chat goes out as a ping');
    assert.equal(JSON.stringify(events).includes('secret'), false);
    assert.ok(sent.every((s) => s.url === 'https://events.test/event'));
  });
});
