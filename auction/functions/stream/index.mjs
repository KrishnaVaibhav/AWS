// DynamoDB Streams consumer: turns table changes into live events.
//   /public/auction/{aid}  item state (public fields only), results, chat
//   /user/{sub}            outbid, bid decided, balance changed, owner alerts
// Personal events also land in the user's inbox and go out as Web Push.
// Pushes carry only what the public may see; signed-in clients refetch from
// the API, which applies their own visibility.

import { unmarshall } from '@aws-sdk/util-dynamodb';
import { keys, batchGet } from '../lib/db.mjs';
import { publish } from '../lib/aws.mjs';
import { notify } from '../lib/notify.mjs';
import { effectiveRules } from '../lib/rules.mjs';
import { ANONYMOUS, publicState, viewChat } from '../lib/visibility.mjs';

const kindOf = (sk) => (sk === 'STATE' || sk === 'RESULT' || sk === 'META' ? sk : sk.split('#')[0]);

export const handler = async (event) => {
  const changes = event.Records.map((r) => ({
    name: r.eventName,
    next: r.dynamodb.NewImage ? unmarshall(r.dynamodb.NewImage) : null,
    prev: r.dynamodb.OldImage ? unmarshall(r.dynamodb.OldImage) : null,
  })).map((c) => ({ ...c, row: c.next ?? c.prev, kind: kindOf((c.next ?? c.prev).SK) }));

  // Rules (and item overrides) for every auction touched in this batch.
  const wanted = [];
  for (const c of changes) {
    if (!c.row.aid) continue;
    wanted.push(keys.auction(c.row.aid));
    if (c.kind === 'STATE') wanted.push(keys.item(c.row.aid, c.row.iid));
  }
  const rows = wanted.length ? await batchGet(wanted) : new Map();
  const meta = (aid) => rows.get(`AUC#${aid}|META`);

  const out = [];
  const personal = [];
  const pub = (aid, event) => out.push({ channel: `/public/auction/${aid}`, event });
  const user = (uid, event) => {
    if (!uid || uid === 'system') return;
    out.push({ channel: `/user/${uid}`, event });
    // Balance pings are frequent and need no inbox row or push.
    if (event.type !== 'balance') personal.push({ uid, event });
  };

  for (const { name, next, prev, row, kind } of changes) {
    const m = meta(row.aid);
    if (!m && kind !== 'META') continue;
    switch (kind) {
      case 'STATE': {
        if (!next) break;
        const item = rows.get(`AUC#${row.aid}|ITEM#${row.iid}`);
        const rules = effectiveRules(m.rules, item?.overrides);
        pub(row.aid, { type: 'item', iid: row.iid, state: publicState(rules, next) });
        if (prev?.leaderId && prev.leaderId !== next.leaderId) user(prev.leaderId, { type: 'outbid', aid: row.aid, iid: row.iid });
        if ((next.pendingCount ?? 0) > (prev?.pendingCount ?? 0)) user(m.hostId, { type: 'bid_pending', aid: row.aid, iid: row.iid });
        break;
      }
      case 'RESULT':
        if (name !== 'INSERT') break;
        pub(row.aid, { type: 'result', iid: row.iid, outcome: row.outcome });
        if (row.winnerId) user(row.winnerId, { type: 'won', aid: row.aid, iid: row.iid, price: row.price });
        user(m.hostId, { type: 'item_closed', aid: row.aid, iid: row.iid, outcome: row.outcome, price: row.price });
        break;
      case 'OFFER':
        if (name === 'INSERT' && next.status === 'pending') user(m.hostId, { type: 'offer_pending', aid: row.aid, iid: row.iid });
        if (prev?.status === 'pending' && next?.status === 'countered') {
          user(row.uid, { type: 'offer_countered', aid: row.aid, iid: row.iid, amount: next.counterAmount });
        }
        if (prev?.status === 'pending' && ['accepted', 'declined'].includes(next?.status)) {
          user(row.uid, { type: 'offer_decided', aid: row.aid, iid: row.iid, status: next.status });
        }
        break;
      case 'BID':
        if (prev?.status === 'pending' && next && next.status !== 'pending' && next.decidedBy !== row.uid) {
          user(row.uid, { type: 'bid_decided', aid: row.aid, iid: row.iid, bidId: row.bidId, status: next.status });
        }
        if (prev?.status === 'accepted' && next?.status === 'cancelled') {
          user(row.uid, { type: 'bid_cancelled', aid: row.aid, iid: row.iid, bidId: row.bidId });
        }
        break;
      case 'CHAT': {
        if (!next) break;
        const chat = m.rules.chat;
        // Public chat goes out in full; otherwise a ping, and members fetch it.
        if (chat.enabled && chat.read === 'public') pub(row.aid, { type: 'chat', message: viewChat(ANONYMOUS, m.rules, next) });
        else pub(row.aid, { type: 'chat_ping', id: row.id });
        break;
      }
      case 'BAL':
        if (next && next.version !== prev?.version) user(row.uid, { type: 'balance', aid: row.aid });
        break;
      case 'REG':
        if (name === 'INSERT' && next.status === 'pending') user(m.hostId, { type: 'registration_pending', aid: row.aid });
        if (prev && next && prev.status !== next.status) user(row.uid, { type: 'registration', aid: row.aid, status: next.status });
        break;
      case 'META':
        if (next && prev && prev.status !== next.status) pub(row.aid, { type: 'auction', status: next.status });
        break;
      default:
        break; // LOG, LEDGER, PENDING, ITEM, NOTE, WATCH...: nothing live
    }
  }
  await Promise.all([
    publish(out),
    notify(personal).catch((err) => console.error(JSON.stringify({ msg: 'notify failed', error: String(err) }))),
  ]);
  console.log(JSON.stringify({ msg: 'stream batch', records: changes.length, published: out.length, notified: personal.length }));
};
