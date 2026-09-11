// The two positions this channel counts in, kept apart from the rules and apart
// from the network, because both of the other files here need them and neither
// should have to import the other to get them.
//
// A conversation and the update stream are ordered by different numbers, and
// conflating them is the mistake this file exists to make impossible.
//
//   the message id  orders a chat. Telegram numbers a chat's messages in order,
//                   and an edit arrives carrying the id of the message it
//                   corrects, which is how a correction of something read long
//                   ago sits below the message cursor and above the revision
//                   cursor.
//   the update id   orders the account's whole update stream, and is what the
//                   next `getUpdates` asks past. It is the watermark, and it
//                   moves only after a capture is on disk, because the Bot API
//                   deletes an update as soon as a call asks for an offset past
//                   it and there is no second delivery.

// Zero-padded, because a cursor is compared as a string and a chat reaches six
// figures of messages without trying.
export function positionOf(messageId) {
  return String(messageId).padStart(12, '0');
}

export function offsetPositionOf(updateId) {
  return String(updateId).padStart(16, '0');
}

// Where the offset lives: one cursor for the account's update stream, under a
// conversation id no chat can collide with, because a chat id is an integer and
// this is not.
export function updatesConversation(account) {
  return `${account}:updates`;
}

// The offset the next call asks for: one past the highest update this store has
// written. Null when nothing has ever been consumed, which asks the server for
// whatever it is still holding.
export function nextOffset(store, account) {
  const held = store.cursors(updatesConversation(account)).message;
  if (held === null || held === undefined) return null;
  const at = Number(held);
  return Number.isFinite(at) ? at + 1 : null;
}
