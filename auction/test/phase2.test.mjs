// End-to-end tests for the formats, Buy It Now, offers, private access,
// watchlist, notifications, templates, clone, import, delete, invoices,
// analytics, uploads and Web Push, against DynamoDB Local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { setupEnv, reachable, createTable, client, ENDPOINT } from './harness.mjs';

setupEnv('auction-p2');
const up = await reachable();

test('phase 2 end to end', { skip: !up && `no DynamoDB Local at ${ENDPOINT}` }, async (t) => {
  await createTable(t);
  const { users, call } = await client(['owner', 'alice', 'bob', 'carol', 'dave']);
  const ops = await import('../functions/lib/auction.mjs');
  const { endingSoon } = await import('../functions/cron/index.mjs');
  const { notify } = await import('../functions/lib/notify.mjs');

  const ok = async (expected, promise) => {
    const res = await promise;
    assert.equal(res.status, expected, JSON.stringify(res.body));
    return res.body;
  };
  const closesAt = Date.now() + 3_600_000;
  const iso = new Date(closesAt).toISOString();

  /** Draft with rules, items, published. Returns { aid, items: [iid...] }. */
  async function auction(rules, itemBodies = [{ title: 'Item' }]) {
    const { auction: a } = await ok(201, call('POST', '/api/auctions', {
      as: 'owner', body: { title: `Test ${rules.format ?? 'english'}`, rules: { timing: { closesAt: iso }, increment: { confirmAbovePct: 0 }, ...rules } },
    }));
    const items = [];
    for (const b of itemBodies) items.push((await ok(201, call('POST', `/api/auctions/${a.id}/items`, { as: 'owner', body: b }))).item.id);
    await ok(200, call('POST', `/api/auctions/${a.id}/publish`, { as: 'owner' }));
    return { aid: a.id, items };
  }
  const bal = async (aid, who) => (await ok(200, call('GET', `/api/auctions/${aid}`, { as: who }))).auction.balance;
  const bid = (aid, iid, who, body) => call('POST', `/api/auctions/${aid}/items/${iid}/bids`, { as: who, body });

  await t.test('sealed second-price: hidden until close, replace bids, winner pays the second bid', async () => {
    const { aid, items: [iid] } = await auction({ format: 'sealed_second', price: { start: 50 }, balance: { enabled: true, startingCredit: 1000 } });
    await ok(201, bid(aid, iid, 'alice', { amount: 100 }));
    await ok(201, bid(aid, iid, 'bob', { amount: 150 }));
    await ok(201, bid(aid, iid, 'carol', { amount: 120 }));
    const replaced = await ok(201, bid(aid, iid, 'alice', { amount: 130 }));
    assert.equal(replaced.outcome, 'replaced');
    assert.deepEqual([(await bal(aid, 'alice')).committed, (await bal(aid, 'bob')).committed], [130, 150]);

    const owner = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}`, { as: 'owner' }))).item.state;
    assert.deepEqual([owner.price, owner.leader, owner.bidCount], [null, null, 3]);
    const mine = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}`, { as: 'alice' }))).item.state;
    assert.equal(mine.you.sealedBid, 130);
    const ownerBids = await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}/bids`, { as: 'owner' }));
    assert.ok(ownerBids.bids.every((b) => b.amount === null), 'owner is blind too');
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}/board`, { as: 'owner' }))).board, null);

    const closed = await ops.closeItem(iid, { now: closesAt + 1000, reschedule: false });
    assert.deepEqual([closed.result, closed.price], ['sold', 130]);
    const won = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}`, { as: 'bob' }))).item.state;
    assert.equal(won.result.winner.you, true);
    assert.deepEqual(await bal(aid, 'bob'), { ...(await bal(aid, 'bob')), balance: 870, committed: 0, available: 870 });
    assert.deepEqual([(await bal(aid, 'alice')).committed, (await bal(aid, 'carol')).committed], [0, 0]);
    const board = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}/board`, { as: 'owner' }))).board;
    assert.deepEqual(board.rows.map((r) => r.amount), [150, 130, 120]);
  });

  await t.test('dutch: the first to accept buys at the current clock price', async () => {
    const { aid, items: [iid] } = await auction({ format: 'dutch', price: { dutch: { start: 100, step: 10, everySec: 60, floor: 50 } } });
    const state = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}`))).item.state;
    assert.equal(state.price, 100);
    const ctx = await ops.loadAuction(aid, users.alice);
    const out = await ops.placeBid(ctx, iid, { amount: 100 }, state.opensAt + 125_000);
    assert.deepEqual([out.outcome, out.price], ['won', 80]);
    const late = await bid(aid, iid, 'bob', { amount: 100 });
    assert.equal(late.body.error, 'auction_not_live', 'its only item sold, so the auction ended');
    const done = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}`, { as: 'alice' }))).item.state;
    assert.deepEqual([done.status, done.result.price], ['closed', 80]);
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'owner' }))).auction.status, 'ended');
  });

  await t.test('reverse: lowest bid wins, reserve is the budget', async () => {
    const { aid, items: [iid] } = await auction({ format: 'reverse', price: { start: 1000, reserve: 800 }, increment: { fixed: 50, confirmAbovePct: 0 } });
    await ok(201, bid(aid, iid, 'alice', { amount: 950 }));
    await ok(201, bid(aid, iid, 'bob', { amount: 900 }));
    assert.equal((await bid(aid, iid, 'alice', { amount: 860 })).body.error, 'above_max');
    await ok(201, bid(aid, iid, 'alice', { amount: 800 }));
    const s = (await ok(200, call('GET', `/api/auctions/${aid}/items/${iid}`))).item.state;
    assert.deepEqual([s.price, s.direction, s.nextMin], [800, 'down', 750]);
    const closed = await ops.closeItem(iid, { now: closesAt + 1000, reschedule: false });
    assert.deepEqual([closed.result, closed.price], ['sold', 800]);
  });

  await t.test('Buy It Now ends the item and goes away after the first bid', async () => {
    const { aid, items: [a, b] } = await auction({ price: { start: 10, buyNow: { amount: 500 } }, balance: { enabled: true, startingCredit: 600 } }, [{ title: 'A' }, { title: 'B' }]);
    const bought = await ok(201, call('POST', `/api/auctions/${aid}/items/${a}/buy`, { as: 'carol' }));
    assert.deepEqual([bought.status, bought.price, bought.item.state.result.via], ['sold', 500, 'buy_now']);
    assert.equal((await bal(aid, 'carol')).balance, 100);
    await ok(201, bid(aid, b, 'alice', { amount: 10 }));
    const gone = await call('POST', `/api/auctions/${aid}/items/${b}/buy`, { as: 'bob' });
    assert.equal(gone.body.error, 'buy_now_unavailable');
    const again = await call('POST', `/api/auctions/${aid}/items/${a}/buy`, { as: 'bob' });
    assert.equal(again.body.error, 'buy_now_unavailable');
  });

  let fixedAid;
  await t.test('fixed price: buy, offers with auto decline/accept, counter-offers', async () => {
    const { aid, items: [x, y, z] } = await auction({
      format: 'fixed_price', price: { start: 200, offers: { enabled: true, autoAccept: 180, autoDecline: 100 } },
    }, [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }]);
    fixedAid = aid;
    assert.equal((await bid(aid, x, 'bob', { amount: 200 })).body.error, 'use_buy');
    const low = await ok(201, call('POST', `/api/auctions/${aid}/items/${x}/offers`, { as: 'bob', body: { amount: 90 } }));
    assert.deepEqual([low.offer.status, low.offer.auto], ['declined', true]);
    const mid = await ok(201, call('POST', `/api/auctions/${aid}/items/${x}/offers`, { as: 'bob', body: { amount: 150, message: 'Cash today' } }));
    assert.equal(mid.offer.status, 'pending');
    assert.equal((await call('POST', `/api/auctions/${aid}/items/${x}/offers`, { as: 'bob', body: { amount: 160 } })).body.error, 'offer_open');
    const list = await ok(200, call('GET', `/api/auctions/${aid}/items/${x}/offers`, { as: 'owner' }));
    assert.equal(list.offers.length, 2);
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}/items/${x}/offers`, { as: 'alice' }))).offers.length, 0);
    const countered = await ok(200, call('POST', `/api/auctions/${aid}/items/${x}/offers/${mid.offer.id}/decision`, { as: 'owner', body: { action: 'counter', amount: 170 } }));
    assert.deepEqual([countered.offer.status, countered.offer.counterAmount], ['countered', 170]);
    const accepted = await ok(200, call('POST', `/api/auctions/${aid}/items/${x}/offers/${mid.offer.id}/respond`, { as: 'bob', body: { accept: true } }));
    assert.equal(accepted.offer.status, 'accepted');
    const sold = (await ok(200, call('GET', `/api/auctions/${aid}/items/${x}`, { as: 'bob' }))).item.state.result;
    assert.deepEqual([sold.price, sold.via], [170, 'offer']);

    const auto = await ok(201, call('POST', `/api/auctions/${aid}/items/${y}/offers`, { as: 'alice', body: { amount: 185 } }));
    assert.equal(auto.offer.status, 'accepted');
    const bought = await ok(201, call('POST', `/api/auctions/${aid}/items/${z}/buy`, { as: 'carol' }));
    assert.equal(bought.price, 200);
  });

  await t.test('invoices and payment status', async () => {
    const all = await ok(200, call('GET', `/api/auctions/${fixedAid}/invoices`, { as: 'owner' }));
    assert.equal(all.invoices.length, 3);
    const items = (await ok(200, call('GET', `/api/auctions/${fixedAid}/items`, { as: 'owner' }))).items;
    const x = items.find((i) => i.title === 'X');
    await ok(200, call('PATCH', `/api/auctions/${fixedAid}/items/${x.id}/result`, { as: 'owner', body: { payment: { status: 'paid', note: 'Cash' }, fulfillment: { status: 'picked_up' } } }));
    const mine = await ok(200, call('GET', `/api/auctions/${fixedAid}/invoices`, { as: 'bob' }));
    assert.equal(mine.invoices.length, 1);
    assert.deepEqual([mine.invoices[0].lines[0].payment.status, mine.invoices[0].unpaid], ['paid', 0]);
    assert.equal((await call('PATCH', `/api/auctions/${fixedAid}/items/${x.id}/result`, { as: 'bob', body: { payment: { status: 'paid' } } })).status, 403);
  });

  await t.test('private auction: unlisted, locked until the code or an invite', async () => {
    const { aid, items: [iid] } = await auction({ access: { mode: 'code', code: 'SECRET-1', invites: ['carol@example.test'] } });
    const live = await ok(200, call('GET', '/api/auctions'));
    assert.ok(!live.auctions.some((a) => a.id === aid));
    const locked = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'dave' }));
    assert.deepEqual([locked.auction.locked, locked.auction.rules], [true, undefined]);
    assert.equal((await call('GET', `/api/auctions/${aid}/items`, { as: 'dave' })).body.error, 'access_code_required');
    assert.equal((await call('GET', `/api/auctions/${aid}/chat`)).body.error, 'access_code_required');
    assert.equal((await call('POST', `/api/auctions/${aid}/register`, { as: 'dave', body: { code: 'nope' } })).status, 403);
    await ok(201, call('POST', `/api/auctions/${aid}/register`, { as: 'dave', body: { code: 'SECRET-1' } }));
    await ok(200, call('GET', `/api/auctions/${aid}/items`, { as: 'dave' }));
    await ok(201, call('POST', `/api/auctions/${aid}/register`, { as: 'carol' }));
    const ownerView = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'owner' }));
    assert.equal(ownerView.auction.rules.access.code, 'SECRET-1');
    const daveView = await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'dave' }));
    assert.deepEqual(daveView.auction.rules.access, { mode: 'code' });
    assert.ok(iid);
  });

  await t.test('watchlist, my bids, ending-soon alerts, inbox', async () => {
    const { aid, items: [iid] } = await auction({}, [{ title: 'Clock' }]);
    await ok(200, call('POST', `/api/auctions/${aid}/items/${iid}/watch`, { as: 'alice' }));
    await ok(201, bid(aid, iid, 'bob', { amount: 1 }));
    const watch = await ok(200, call('GET', '/api/me/watchlist', { as: 'alice' }));
    assert.deepEqual(watch.items.map((x) => x.item.title), ['Clock']);
    const mine = await ok(200, call('GET', '/api/me/bids', { as: 'bob' }));
    assert.ok(mine.items.some((x) => x.item.id === iid && x.item.state.you.leading));
    assert.equal(await endingSoon(closesAt - 5 * 60_000), 1);
    assert.equal(await endingSoon(closesAt - 4 * 60_000), 0, 'one alert per watcher');
    const inbox = await ok(200, call('GET', '/api/me/notifications', { as: 'alice' }));
    assert.equal(inbox.notifications[0].type, 'ending_soon');
    assert.match(inbox.notifications[0].text, /Clock/);
    await ok(200, call('DELETE', `/api/auctions/${aid}/items/${iid}/watch`, { as: 'alice' }));
    assert.equal((await ok(200, call('GET', '/api/me/watchlist', { as: 'alice' }))).items.length, 0);
    assert.equal((await call('GET', '/api/me/bids')).status, 401);
  });

  await t.test('templates, clone, CSV import, delete', async () => {
    const tpl = await ok(201, call('POST', '/api/templates', { as: 'owner', body: { name: 'Charity', rules: { chat: { hostOnly: true }, price: { currency: 'EUR' } } } }));
    assert.equal(tpl.template.rules.timing.closesAt, null);
    const fromTpl = await ok(201, call('POST', '/api/auctions', { as: 'owner', body: { title: 'Gala', templateId: tpl.template.id, rules: { price: { start: 5 } } } }));
    assert.deepEqual([fromTpl.auction.rules.chat.hostOnly, fromTpl.auction.rules.price.currency, fromTpl.auction.rules.price.start], [true, 'EUR', 5]);
    assert.equal((await ok(200, call('GET', '/api/templates', { as: 'owner' }))).templates.length, 1);
    assert.equal((await ok(200, call('GET', '/api/templates', { as: 'alice' }))).templates.length, 0);

    const aid = fromTpl.auction.id;
    const bad = await call('POST', `/api/auctions/${aid}/items/import`, { as: 'owner', body: { csv: 'title,start\nLamp,10\n,5\nVase,abc\n' } });
    assert.equal(bad.body.error, 'import_failed');
    assert.deepEqual(bad.body.errors.map((e) => e.row), [3, 4]);
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}/items`, { as: 'owner' }))).items.length, 0, 'all or nothing');
    const good = await ok(201, call('POST', `/api/auctions/${aid}/items/import`, {
      as: 'owner', body: { csv: 'title,lot,start,reserve,field:color\n"Lamp, brass",1,10,50,gold\nVase,2,20,,blue\n' },
    }));
    assert.equal(good.imported, 2);
    const items = (await ok(200, call('GET', `/api/auctions/${aid}/items`, { as: 'owner' }))).items;
    const lamp = items.find((i) => i.title === 'Lamp, brass');
    assert.deepEqual([lamp.fields.color, lamp.overrides.price.start, lamp.overrides.price.reserve], ['gold', 10, 50]);

    const clone = await ok(201, call('POST', `/api/auctions/${aid}/clone`, { as: 'owner', body: { title: 'Gala 2027' } }));
    assert.equal(clone.auction.itemCount, 2);
    assert.equal((await ok(200, call('GET', `/api/auctions/${clone.auction.id}/items`, { as: 'owner' }))).items.length, 2);

    await ok(200, call('DELETE', `/api/auctions/${aid}/items/${lamp.id}`, { as: 'owner' }));
    assert.equal((await ok(200, call('GET', `/api/auctions/${aid}`, { as: 'owner' }))).auction.itemCount, 1);
    await ok(200, call('DELETE', `/api/auctions/${clone.auction.id}`, { as: 'owner' }));
    assert.equal((await call('GET', `/api/auctions/${clone.auction.id}`, { as: 'owner' })).status, 404);

    const live = await auction({}, [{ title: 'Busy' }]);
    await ok(201, bid(live.aid, live.items[0], 'alice', { amount: 1 }));
    assert.equal((await call('DELETE', `/api/auctions/${live.aid}/items/${live.items[0]}`, { as: 'owner' })).body.error, 'has_history');
    assert.equal((await call('DELETE', `/api/auctions/${live.aid}`, { as: 'owner' })).body.error, 'not_draft');
  });

  await t.test('analytics', async () => {
    await ok(200, call('GET', `/api/auctions/${fixedAid}`, { as: 'dave' })); // a page view
    const { analytics } = await ok(200, call('GET', `/api/auctions/${fixedAid}/analytics`, { as: 'owner' }));
    assert.deepEqual([analytics.totals.sold, analytics.totals.revenue, analytics.totals.sellThrough], [3, 555, 1]);
    assert.ok(analytics.totals.views >= 1, 'non-owner item list views are counted');
    assert.equal((await call('GET', `/api/auctions/${fixedAid}/analytics`, { as: 'bob' })).status, 403);
  });

  await t.test('uploads: presigned POST to incoming/, checked types and sizes', async () => {
    const { auction: a } = await ok(201, call('POST', '/api/auctions', { as: 'owner', body: { title: 'Media' } }));
    const { item } = await ok(201, call('POST', `/api/auctions/${a.id}/items`, { as: 'owner', body: { title: 'Painting' } }));
    const { upload } = await ok(201, call('POST', `/api/auctions/${a.id}/items/${item.id}/uploads`, { as: 'owner', body: { contentType: 'image/jpeg', size: 1000 } }));
    assert.equal(upload.url, 'https://test-media-bucket.s3.us-east-1.amazonaws.com/');
    assert.match(upload.fields.key, new RegExp(`^incoming/${a.id}/${item.id}/[0-9a-f-]+\\.jpg$`));
    assert.equal(upload.mediaKey, upload.fields.key.replace('incoming/', 'media/'));
    const policy = JSON.parse(Buffer.from(upload.fields.policy, 'base64').toString());
    assert.ok(policy.conditions.some((c) => Array.isArray(c) && c[0] === 'content-length-range' && c[2] === 1000));
    assert.equal((await call('POST', `/api/auctions/${a.id}/items/${item.id}/uploads`, { as: 'owner', body: { contentType: 'text/html', size: 10 } })).status, 400);
    assert.equal((await call('POST', `/api/auctions/${a.id}/items/${item.id}/uploads`, { as: 'owner', body: { contentType: 'image/png', size: 26 * 1024 * 1024 } })).status, 400);
    assert.equal((await call('POST', `/api/auctions/${a.id}/items/${item.id}/uploads`, { as: 'alice', body: { contentType: 'image/png', size: 10 } })).status, 404);
  });

  await t.test('Web Push: subscribe, encrypted delivery, dead subscriptions removed', async () => {
    const key = await ok(200, call('GET', '/api/push/key'));
    assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: 'MDEyMzQ1Njc4OWFiY2RlZg' } };
    assert.equal((await call('POST', '/api/me/push', { as: 'alice', body: { subscription: { ...subscription, endpoint: 'https://evil.example/x' } } })).status, 400);
    await ok(201, call('POST', '/api/me/push', { as: 'alice', body: { subscription } }));

    const sent = [];
    const realFetch = globalThis.fetch;
    let status = 201;
    globalThis.fetch = async (url, init) => { sent.push({ url, headers: init.headers, body: init.body }); return new Response(null, { status }); };
    try {
      await notify([{ uid: users.alice.uid, event: { type: 'outbid', aid: 'x', iid: 'y' } }]);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, subscription.endpoint);
      assert.equal(sent[0].headers['content-encoding'], 'aes128gcm');
      assert.match(sent[0].headers.authorization, /^vapid t=.+, k=/);
      status = 410;
      await notify([{ uid: users.alice.uid, event: { type: 'outbid' } }]);
      sent.length = 0;
      await notify([{ uid: users.alice.uid, event: { type: 'outbid' } }]);
      assert.equal(sent.length, 0, 'a 410 deletes the subscription');
    } finally {
      globalThis.fetch = realFetch;
    }
    const inbox = await ok(200, call('GET', '/api/me/notifications', { as: 'alice' }));
    assert.ok(inbox.notifications.filter((n) => n.type === 'outbid').length >= 3);
  });
});
