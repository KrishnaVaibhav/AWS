// Runs every minute.
// 1. Safety net for the per-item schedules: closes any open item whose time
//    has passed (missed or failed schedules, clock edges).
// 2. Ending-soon alerts: watchers of items closing in the next 15 minutes
//    get one notification each.
import { sweepOverdue } from '../lib/auction.mjs';
import { keys, get, query, queryIndex, Tx, TxConflict } from '../lib/db.mjs';
import { notify } from '../lib/notify.mjs';

const SOON_MIN = 15;

export async function endingSoon(now = Date.now()) {
  const soon = await queryIndex('GSI1', 'STATUS#open', {
    desc: false, gte: new Date(now).toISOString(), lte: new Date(now + SOON_MIN * 60_000).toISOString(), limit: 100,
  });
  const alerts = [];
  for (const state of soon) {
    const watchers = (await query(`ITEM#${state.iid}`, 'WATCHER#')).filter((w) => !w.alerted);
    if (!watchers.length) continue;
    const item = await get(keys.item(state.aid, state.iid));
    for (const w of watchers) {
      // Mark first, so a retry never alerts twice.
      try {
        await new Tx().update(keys.watcher(state.iid, w.uid), {
          set: ['alerted = :t'], condition: 'alerted = :f', values: { ':t': true, ':f': false }, reason: 'done',
        }).run();
      } catch (err) {
        if (err instanceof TxConflict) continue;
        throw err;
      }
      alerts.push({ uid: w.uid, event: { type: 'ending_soon', aid: state.aid, iid: state.iid, title: item?.title ?? 'An item', minutes: SOON_MIN } });
    }
  }
  if (alerts.length) await notify(alerts, now);
  return alerts.length;
}

export const handler = async () => {
  const [results, alerted] = await Promise.all([sweepOverdue(), endingSoon()]);
  if (results.length || alerted) console.log(JSON.stringify({ msg: 'sweep', closed: results, alerted }));
};
