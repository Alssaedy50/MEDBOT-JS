/**
 * Internal error logging for MEDBOT.
 *
 * Several subsystems are deliberately failure-isolated: an archive mirror, a
 * private delivery or a best-effort cache warm must never take the bot down. The
 * risk of "never throws" is that a real problem becomes invisible. This module
 * is the single place those non-fatal failures are recorded, so an operator can
 * see them in the process log without the user ever receiving a stack trace.
 *
 * The message never carries a secret: callers pass a context label and the raw
 * error, and only the error's `message` is emitted (never a token or a payload).
 */

/** Report a non-fatal failure. Returns the same error for convenient chaining. */
export function logFailure(context, error) {
  const detail = error?.message ?? String(error ?? 'unknown error');
  console.error(`[MEDBOT] ${context}: ${detail}`);
  return error;
}

/** Report a non-fatal warning with a plain message. */
export function logWarning(context, message) {
  console.warn(`[MEDBOT] ${context}: ${message}`);
}
