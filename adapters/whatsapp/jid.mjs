// Chat keys, and why there is only one of them.
//
// WhatsApp is part way through a rollout that gives every account a second
// identifier. A chat used to be named by the contact's phone number,
// `<digits>@s.whatsapp.net`; it is now increasingly named by a linked id,
// `<digits>@lid`, and an event carries whichever the server chose plus the
// other form beside it in `remoteJidAlt`. Taking whichever field happens to be
// filled — the earlier platform's `remoteJidAlt || remoteJid` — splits one chat
// into two conversations the moment the server changes its mind, and the store
// then refuses the reply, because a reply goes out on the conversation the
// inbound arrived on and the agent no longer owns the other half.
//
// So this adapter has one rule and applies it everywhere: **the canonical chat
// key is the linked-id form when the event offers one, and the server's own jid
// otherwise.** A group and a broadcast list have no linked-id form and keep
// their own jid. The phone form is not thrown away: it is written into a map
// under the store, and that map exists for exactly one job, joining a history
// export whose chats are keyed by phone number to the conversations the live
// adapter already keyed by linked id.

const LID_SERVER = 'lid';
const PHONE_SERVER = 's.whatsapp.net';
const GROUP_SERVER = 'g.us';

export function serverOf(jid) {
  if (typeof jid !== 'string') return null;
  const at = jid.lastIndexOf('@');
  return at < 0 ? null : jid.slice(at + 1);
}

export function isLid(jid) {
  return serverOf(jid) === LID_SERVER;
}

export function isPhoneJid(jid) {
  return serverOf(jid) === PHONE_SERVER;
}

export function isGroup(jid) {
  return serverOf(jid) === GROUP_SERVER;
}

// One account reaches the server from several devices, and the server writes the
// device onto the jid as `<user>:<device>@<server>`. The device is not part of
// who someone is, so it is dropped before the jid is used as a key. Nothing else
// about the jid is rewritten: a jid carrying something it should not, a control
// byte for instance, stays exactly as it arrived, so the store's own refusal
// sees it and reports it rather than this function quietly repairing it.
export function normaliseJid(jid) {
  if (typeof jid !== 'string') return jid;
  const at = jid.lastIndexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0].split('/')[0];
  return `${user}@${jid.slice(at + 1)}`;
}

// The canonical chat key: the linked-id form when the event carries one.
export function canonicalChatKey(key = {}) {
  const candidates = [key.remoteJid, key.remoteJidAlt]
    .filter((jid) => typeof jid === 'string' && jid.length > 0)
    .map(normaliseJid);
  if (candidates.length === 0) return null;
  return candidates.find(isLid) ?? candidates[0];
}

// The same rule for the person who spoke, which in a group is the participant
// and not the chat.
export function canonicalParticipant(key = {}) {
  const candidates = [key.participant, key.participantAlt]
    .filter((jid) => typeof jid === 'string' && jid.length > 0)
    .map(normaliseJid);
  if (candidates.length === 0) return null;
  return candidates.find(isLid) ?? candidates[0];
}

// Every phone-form and linked-id-form pair the event puts side by side, so the
// map under the store can learn them. A pair is only learned when the event
// carries both forms of one identity; nothing is inferred from one form alone.
export function pairsIn(key = {}) {
  const pairs = [];
  const consider = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return;
    const one = normaliseJid(a);
    const other = normaliseJid(b);
    const phone = [one, other].find(isPhoneJid);
    const lid = [one, other].find(isLid);
    if (phone && lid) pairs.push({ phone, lid });
  };
  consider(key.remoteJid, key.remoteJidAlt);
  consider(key.participant, key.participantAlt);
  return pairs;
}

export function conversationKind(chatKey) {
  return isGroup(chatKey) ? 'group' : 'direct';
}
