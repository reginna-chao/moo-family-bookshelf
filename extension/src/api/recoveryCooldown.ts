/** Recovery-join cooldown helpers for `auth-refresh.ts`, split out of it to keep it under its line
 *  ceiling. Twin: `pwa/src/utils/recoveryCooldown.ts`. Why: docs/architecture.md → 認證更新與冷卻. */

import browser from "webextension-polyfill";
import { RECOVERY_COOLDOWN_UNTIL_KEY } from "../constants";

/** Fallback cooldown (seconds) when a 429 body omits `retryAfter`. */
const DEFAULT_RECOVERY_COOLDOWN_SECONDS = 300;

/** 1 h cap on a backend `retryAfter` (the official worker asks ≤ 900 s; this stops a BYO backend
 *  locking recovery out). Mirrors `dialog/useRetryCountdown.ts`, kept local: api never imports dialog. */
const MAX_RECOVERY_COOLDOWN_SECONDS = 3600;

/** Active deadline or undefined; an over-long one is re-saved (best-effort) at the 1 h max, so it self-heals. */
export async function getActiveRecoveryCooldown(): Promise<number | undefined> {
  const stored = await browser.storage.local.get(RECOVERY_COOLDOWN_UNTIL_KEY);
  const cooldownUntil = stored[RECOVERY_COOLDOWN_UNTIL_KEY];
  if (typeof cooldownUntil !== "number") return undefined;
  const now = Date.now();
  const maxDeadline = now + MAX_RECOVERY_COOLDOWN_SECONDS * 1000;
  if (cooldownUntil > maxDeadline) {
    return setRecoveryCooldown(MAX_RECOVERY_COOLDOWN_SECONDS).catch(
      () => maxDeadline,
    );
  }
  return now < cooldownUntil ? cooldownUntil : undefined;
}

/** Persist a fresh recovery cooldown and return its epoch-ms deadline; the wait is clamped to
 *  `MAX_RECOVERY_COOLDOWN_SECONDS` so an untrusted backend cannot suppress auto-recovery forever. */
export async function setRecoveryCooldown(
  retryAfterSeconds?: number,
): Promise<number> {
  const requested =
    typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_RECOVERY_COOLDOWN_SECONDS;
  const seconds = Math.min(requested, MAX_RECOVERY_COOLDOWN_SECONDS);
  const cooldownUntil = Date.now() + seconds * 1000;
  await browser.storage.local.set({
    [RECOVERY_COOLDOWN_UNTIL_KEY]: cooldownUntil,
  });
  return cooldownUntil;
}

/** Clear the recovery cooldown so a recovered client is never stale-throttled. */
export async function clearRecoveryCooldown(): Promise<void> {
  await browser.storage.local.remove(RECOVERY_COOLDOWN_UNTIL_KEY);
}
