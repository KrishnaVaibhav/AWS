// Personal notifications: an inbox row per event (kept 30 days) plus a Web
// Push to every browser the user enabled. Used by the stream and the cron.

import { createHash } from 'node:crypto';
import { keys, put, query, deleteKeys, newId } from './db.mjs';
import { sendPush } from './webpush.mjs';

const TEXT = {
  outbid: () => 'You were outbid.',
  won: (e) => `You won an item${e.price != null ? ` for ${e.price}` : ''}.`,
  bid_decided: (e) => `Your bid was ${e.status}.`,
  bid_cancelled: () => 'The host cancelled one of your bids.',
  balance: () => 'Your balance changed.',
  registration: (e) => `Your registration is now ${e.status}.`,
  bid_pending: () => 'A bid is waiting for your approval.',
  registration_pending: () => 'Someone asked to join your auction.',
  offer_pending: () => 'You have a new offer.',
  offer_countered: (e) => `The seller countered your offer with ${e.amount}.`,
  offer_decided: (e) => `Your offer was ${e.status}.`,
  item_closed: (e) => `An item closed: ${String(e.outcome).replace(/_/g, ' ')}.`,
  ending_soon: (e) => `"${e.title}" closes in less than ${e.minutes} minutes.`,
};

export const textFor = (e) => (TEXT[e.type] ?? (() => 'Auction update'))(e);
export const pushHash = (endpoint) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

/** [{ uid, event }] -> inbox rows + pushes. Never throws for a single bad subscription. */
export async function notify(items, now = Date.now()) {
  const byUser = new Map();
  for (const { uid, event } of items) {
    if (!uid || uid === 'system') continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(event);
  }
  await Promise.all([...byUser].map(async ([uid, events]) => {
    const notes = events.map((e) => ({
      ...keys.note(uid, newId(now)), uid, at: now, ...e, text: textFor(e),
      url: e.aid ? `/#/a/${e.aid}` : '/#/me',
      ttl: Math.floor(now / 1000) + 30 * 86400,
    }));
    await Promise.all(notes.map((n) => put(n)));
    const subs = await query(`USER#${uid}`, 'PUSH#');
    if (!subs.length) return;
    const gone = [];
    for (const sub of subs) {
      // One push per user per batch: the newest event, with a count if several.
      const latest = notes.at(-1);
      const body = notes.length > 1 ? `${latest.text} (+${notes.length - 1} more)` : latest.text;
      const result = await sendPush(sub.subscription, { title: 'Auction', body, url: latest.url });
      if (result === 'gone') gone.push({ PK: sub.PK, SK: sub.SK });
    }
    if (gone.length) await deleteKeys(gone);
  }));
}
