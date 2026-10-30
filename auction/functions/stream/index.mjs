// DynamoDB Streams consumer. Phase 1 fills this in:
// - ITEM#id/STATE changed -> publish to AppSync Events /public/items/{id}
//   (EVENTS_HTTP, signed with the function's IAM role)
// - outbid bidder -> /user/{sub} + Web Push if they are offline
// - item or catalog META changed -> JSON snapshot + search index to S3
export const handler = async (event) => {
  const counts = {};
  for (const record of event.Records) {
    counts[record.eventName] = (counts[record.eventName] ?? 0) + 1;
  }
  console.log(JSON.stringify({ msg: 'stream batch', counts }));
};
