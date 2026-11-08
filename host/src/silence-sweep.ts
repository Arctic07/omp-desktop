/**
 * The host's own periodic account of a silence: one log line per episode, and nothing acted on.
 *
 * A conversation that stops producing engine events while its turn is still reading is the state the
 * desktop's `lastEventAt` can measure but not explain, so the host writes the explanation itself
 * (`SessionRegistry.sweepSilence`). The tick costs a walk of the live registry, which is why it is
 * an interval and not a check on every frame.
 *
 * **Owner / bound / release.** The host run owns it; it fires every `SILENCE_SWEEP_MS` for as long as
 * the process serves frames. The release point is shutdown: `runHost` calls the disposer it got back
 * before it disposes sessions, so a tick cannot run into a registry that is being torn down - and a
 * teardown that ends in an error path still leaves no timer behind (`WRITE` failure, `stdin` closed,
 * `host_shutdown`, a protocol refusal all reach the same call).
 *
 * Unref'd, so the interval alone never keeps this process alive on its way out: the stdin reader
 * ending is what should decide that.
 */

import { SILENCE_SWEEP_MS } from './constants.ts'

/**
 * Starts the sweep and answers the one call that stops it.
 *
 * `intervalMs` is a parameter for the same reason the registry's own timing is: a test has to watch
 * two ticks without waiting fifteen seconds for the first.
 */
export function startSilenceSweep(
  sweep: () => void,
  intervalMs: number = SILENCE_SWEEP_MS,
): () => void {
  const timer = setInterval(sweep, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
