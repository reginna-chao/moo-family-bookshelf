/**
 * Cooldown for the PWA's SILENT recovery join (the 401 token refresher).
 *
 * Mirrors the cooldown helpers in `extension/src/api/auth-refresh.ts`; the
 * Extension keeps its deadline in `browser.storage.local`, the PWA is
 * browser-only so plain `localStorage` is the equivalent store.
 *
 * The key is GLOBAL, not namespaced per user: what it throttles is the worker's
 * per-IP sensitive tier (3/min), which every account on the device shares.
 *
 * Only the automatic recovery join consults this — a manual, user-initiated
 * join must never be suppressed by it.
 *
 * Every access is wrapped: storage that throws (private mode, quota) degrades
 * to "no cooldown" instead of taking the app down.
 */

/** Epoch ms until which automatic recovery joins are suppressed after a 429. */
export const RECOVERY_COOLDOWN_UNTIL_KEY = "moo:recoveryCooldownUntil";

/** Fallback cooldown (seconds) when a 429 body omits `retryAfter`. */
export const DEFAULT_RECOVERY_COOLDOWN_SECONDS = 300;

/**
 * Upper bound (1 hour) applied to any backend-supplied `retryAfter`. The
 * official worker never asks for more than 900s, so this only guards against a
 * hostile or buggy self-hosted (BYO) backend locking recovery out effectively
 * forever.
 */
export const MAX_RECOVERY_COOLDOWN_SECONDS = 3600;

/**
 * Read the recovery cooldown, returning its epoch-ms deadline only if still
 * active — and SELF-HEAL an over-long one by persisting the clamp.
 *
 * A deadline persisted before the write-side cap existed (or one inflated by a
 * clock skew) is rewritten to `now + MAX_RECOVERY_COOLDOWN_SECONDS`. Clamping
 * only the RETURNED value would bound each individual answer but not the
 * cooldown's LIVENESS: every later read would re-clamp against a fresh `now`,
 * so the cooldown would stay active right up to its original far-future
 * moment. Writing the clamp back is what actually bounds total suppression to
 * the max, measured from the first read that observes the inflated value. The
 * write is best-effort — if storage refuses it, the clamped deadline is still
 * returned and the next read heals again.
 */
export function getActiveRecoveryCooldown(): number | undefined {
  const stored = readStoredDeadline();
  if (stored === undefined) return undefined;
  const now = Date.now();
  const maxDeadline = now + MAX_RECOVERY_COOLDOWN_SECONDS * 1000;
  let bounded = stored;
  if (stored > maxDeadline) {
    persistDeadline(maxDeadline);
    bounded = maxDeadline;
  }
  return now < bounded ? bounded : undefined;
}

/**
 * Persist a fresh recovery cooldown; returns the epoch-ms deadline written.
 *
 * `retryAfterSeconds` comes straight off the response envelope, so it is
 * validated here rather than trusted: anything that is not a finite positive
 * number falls back to `DEFAULT_RECOVERY_COOLDOWN_SECONDS`, and the wait is
 * clamped to `MAX_RECOVERY_COOLDOWN_SECONDS` so an untrusted backend cannot
 * suppress automatic recovery indefinitely.
 */
export function setRecoveryCooldown(retryAfterSeconds?: number): number {
  const requested =
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_RECOVERY_COOLDOWN_SECONDS;
  const seconds = Math.min(requested, MAX_RECOVERY_COOLDOWN_SECONDS);
  const cooldownUntil = Date.now() + seconds * 1000;
  persistDeadline(cooldownUntil);
  return cooldownUntil;
}

/** Clear the cooldown so a recovered client is never stale-throttled. */
export function clearRecoveryCooldown(): void {
  try {
    localStorage.removeItem(RECOVERY_COOLDOWN_UNTIL_KEY);
  } catch {
    // Best-effort, as above.
  }
}

/** Write the deadline; the single persistence point for both write paths. */
function persistDeadline(deadline: number): void {
  try {
    localStorage.setItem(RECOVERY_COOLDOWN_UNTIL_KEY, String(deadline));
  } catch {
    // Best-effort: a refused write costs the throttle, never the session.
  }
}

/** Parse the persisted deadline; anything unusable reads as "no cooldown". */
function readStoredDeadline(): number | undefined {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
