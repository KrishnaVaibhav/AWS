// Runs every minute. Phase 1 fills this in: query GSI1 for items closing in
// the next 15 minutes and alert their watchers, then clean up stale records.
export const handler = async () => {
  console.log(JSON.stringify({ msg: 'sweep' }));
};
