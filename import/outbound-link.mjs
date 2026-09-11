// Joining what the agent said across the places it was written down.
//
// One send leaves three marks in a client's system and no two of them carry the
// same identity. The channel's capture file has the platform's message id and
// the text that went out. The harness's turn table has the text the model
// produced and the ids of the messages it was answering, and no message id at
// all, because the harness handed the text to a bridge and the bridge got the id
// back. The send authority's audit has the chat, the moment and whether the send
// was permitted, and neither the id nor the text.
//
// So the join is: the capture is the spine, because it is the only source with
// the platform's own identity; a turn and an audit row are attached to it by the
// one deterministic key the data offers, which is the conversation plus the
// moment inside a tolerance the mapping sets. A turn or an audit row that
// matches nothing becomes a send of its own, keyed by the id its own row
// carries. Every join says how it was made and how far apart the two marks were,
// and a join that was not made says that instead, because a replay that cannot
// see which links are inferred cannot be read.

const KINDS = ['turn', 'audit'];

export function millisOf(item) {
  const at = Date.parse(String(item?.timestamp ?? ''));
  return Number.isNaN(at) ? null : at;
}

// One deterministic order for every kind, so two runs over the same sources make
// the same joins: earliest first, and the source's own id breaks a tie.
function ordered(items) {
  return [...items].sort((one, other) => {
    const byTime = (millisOf(one) ?? 0) - (millisOf(other) ?? 0);
    if (byTime !== 0) return byTime;
    return String(one.message_id).localeCompare(String(other.message_id));
  });
}

function sendFor(item, method) {
  return { item, attached: {}, links: { [item.kind]: { method } } };
}

// The send this mark belongs to: the nearest in time in the same conversation
// that is not already carrying a mark of this kind. The count of everything else
// inside the window is kept, because "there were four candidates and this was
// the nearest" is a different fact from "there was one".
function nearestSend(pool, item, kind, tolerance) {
  const at = millisOf(item);
  if (at === null) return null;
  let best = null;
  let candidates = 0;
  for (const send of pool) {
    if (send.item.conversation_id !== item.conversation_id) continue;
    if (send.attached[kind] !== undefined) continue;
    const theirs = millisOf(send.item);
    if (theirs === null) continue;
    const delta = Math.abs(theirs - at);
    if (delta > tolerance) continue;
    candidates++;
    if (best === null || delta < best.delta
      || (delta === best.delta && String(send.item.message_id) < String(best.send.item.message_id))) {
      best = { send, delta };
    }
  }
  if (best === null) return null;
  return { ...best, candidates };
}

// The whole join, in one pass per kind. Turns are joined before audit rows, so
// an audit row with no capture beside it can still land on the turn that
// produced it rather than becoming a third orphan of the same send.
export function joinOutbound(items, tolerance) {
  const pool = ordered(items.filter((item) => item.kind === 'event'))
    .map((item) => sendFor(item, 'the platform message id the capture carries'));
  const counts = { event: pool.length, turn: 0, audit: 0, joined: { turn: 0, audit: 0 }, alone: { turn: 0, audit: 0 } };

  for (const kind of KINDS) {
    for (const item of ordered(items.filter((one) => one.kind === kind))) {
      counts[kind]++;
      const found = nearestSend(pool, item, kind, tolerance);
      if (found === null) {
        counts.alone[kind]++;
        pool.push(sendFor(item, 'none: no send was recorded elsewhere in this conversation inside the tolerance'));
        continue;
      }
      counts.joined[kind]++;
      found.send.attached[kind] = item;
      found.send.links[kind] = {
        method: 'conversation and time',
        delta_ms: found.delta,
        tolerance_ms: tolerance,
        candidates: found.candidates,
        joined_id: String(item.message_id)
      };
    }
  }
  return { sends: pool, counts };
}
