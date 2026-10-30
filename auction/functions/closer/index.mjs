// EventBridge Scheduler target: one at(closesAt) schedule per item, created
// in SCHEDULE_GROUP. Phase 1 fills this in:
// - re-read ITEM#id/STATE; if soft close moved closesAt later, create a new
//   schedule for the new time and stop
// - otherwise flip status open -> closed (conditional write), decide the
//   result (winner / reserve not met / no bids), write RESULT + invoice,
//   then notify
export const handler = async (event) => {
  console.log(JSON.stringify({ msg: 'close requested', event }));
};
