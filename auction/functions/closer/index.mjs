// EventBridge Scheduler target: one at(closesAt) schedule per item. closeItem
// re-reads the item: if soft close moved closesAt, or pending bids still have
// time to be decided, it schedules itself again; otherwise it closes the item,
// records the result and charges the winner's balance.
import { closeItem } from '../lib/auction.mjs';

export const handler = async (event) => {
  const result = await closeItem(event.iid);
  console.log(JSON.stringify({ msg: 'close', ...result }));
  return result;
};
