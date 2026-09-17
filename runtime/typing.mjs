// The signal that says a turn is running.
//
// A person who has sent a message to their agent sees nothing at all while the
// model works, which on a long turn is minutes of silence that looks exactly
// like a dead agent. Every chat channel already has the signal for this, and
// this file is the runtime's half of it: one handle per release, started before
// the turn and stopped on the way out of it whatever happened inside.
//
// Two rules hold this file's shape, and both are about the thing it must never
// become. It is cosmetic, so it may never fail, park or delay a release: every
// call to the adapter goes through one wrapper that swallows a throw, logs it
// and gives up on a call that has not settled promptly. And it must never
// outlive the turn: the interval is `unref`'d so it cannot hold the process
// open, it is cleared in the same place the stop is sent, and a `composing`
// that settles after the stop is followed by one more `paused`, because
// otherwise the provider's last instruction is "typing" and the indicator comes
// back on after the reply has already arrived.
//
// Nothing here knows what a channel is. The adapter is the channel.

// How often the signal is re-sent while a turn runs. Telegram's chat action
// lasts about five seconds, so anything at or above that leaves gaps.
const REFRESH_MS = 4000;

// How long the runtime is willing to consider one typing call outstanding. Past
// this the call is abandoned: it may still settle, and the wrapper still catches
// what it does, but nothing here waits on it any longer.
const CALL_BOUND_MS = 2000;

// Start the signal for one release, and hand back the way to stop it.
//
// `stop()` is deliberately not async and the caller does not await a provider:
// Telegram bounds its own calls at sixty seconds and the WhatsApp library's
// presence call has no timeout at all, so a stop the release waited on could
// hold that release for a minute or forever.
export function startTyping({ adapter, context, record, log = () => {} }) {
  // The email path, and the path for any adapter whose channel has no such
  // signal: no call, no log line, and a stop that does nothing.
  if (typeof adapter.typing !== 'function') return { stop: () => {} };

  const state = { stopped: false, inFlight: false };

  const issue = (asked) => {
    // Once stopped, no further `composing` may go out: a tick that raced the
    // stop would turn the indicator back on behind the reply.
    if (asked === 'composing' && state.stopped) return;
    if (asked === 'composing') state.inFlight = true;

    const settled = () => {
      if (asked !== 'composing') return;
      state.inFlight = false;
      // The ordering that matters: a `composing` that landed after the stop
      // leaves the provider holding "typing", so it is followed by a `paused`.
      if (state.stopped) issue('paused');
    };
    const failed = (error) => {
      log({
        event: 'typing.failed',
        channel: context.channel?.kind,
        account: context.account,
        state: asked,
        problem: error?.message ?? String(error)
      });
    };

    let result;
    try {
      result = adapter.typing(context, record, asked);
    } catch (error) {
      failed(error);
      settled();
      return;
    }
    if (typeof result?.then !== 'function') {
      settled();
      return;
    }
    // Abandoned past the bound: the call may still settle into the handlers
    // below, and this only stops the refresh from waiting on it.
    const bound = setTimeout(() => { if (asked === 'composing') state.inFlight = false; }, CALL_BOUND_MS);
    bound.unref?.();
    result.then(() => { clearTimeout(bound); settled(); }, (error) => {
      clearTimeout(bound);
      failed(error);
      settled();
    });
  };

  issue('composing');
  const timer = setInterval(() => { if (!state.inFlight) issue('composing'); }, REFRESH_MS);
  timer.unref?.();

  return {
    stop: () => {
      if (state.stopped) return;
      state.stopped = true;
      clearInterval(timer);
      issue('paused');
    }
  };
}
