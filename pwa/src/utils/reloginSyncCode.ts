import { encodeSyncCode } from "@/crypto/syncCode";
import {
  REMEMBER_SYNC_CODE_KEY,
  REMEMBERED_LOGOUT_KEY,
  type AuthState,
} from "@/hooks/useAuth";

/**
 * Preserve the sync code so LandingPage can pre-fill it and open the
 * verification UI after the logout. Respects the "remember sync code"
 * preference; best-effort, a refused localStorage only costs the pre-fill.
 */
export function rememberSyncCodeForRelogin(auth: AuthState): void {
  if (!auth.familyId) return;
  try {
    if (localStorage.getItem(REMEMBER_SYNC_CODE_KEY) === "0") return;
    localStorage.setItem(
      REMEMBERED_LOGOUT_KEY,
      encodeSyncCode({ familyId: auth.familyId, apiHost: auth.apiHost }),
    );
  } catch {
    /* best-effort */
  }
}
