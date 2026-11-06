import { vi } from "vitest";
import { ACCOUNT_RECREATE_COOLDOWN_MS } from "../../src/kv/schema";

/**
 * Move `Date` one millisecond past `ACCOUNT_RECREATE_COOLDOWN_MS` from now, so a mark a
 * real `DELETE /api/user/:id` just wrote stops refusing a create or a manual join (#468).
 *
 * It fakes `Date` only, so a pending promise and a `holdNextWrite` keep working. It installs
 * fake timers and does not clean up after itself: restore them in `afterEach`
 * (`vi.useRealTimers()`). `vi.restoreAllMocks()` does not do that.
 */
export function passRecreateCooldown(): void {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now + ACCOUNT_RECREATE_COOLDOWN_MS + 1);
}
