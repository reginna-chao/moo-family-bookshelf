/** Structure layer for the auth token and expiry the create / join / refresh responses issue.
 *  Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import { isHexId } from "./hexId";
import {
  sanitizeFamilyGroupText,
  type FamilyGroupTextFields,
} from "./entityText";

interface IssuedCredentialFields {
  authToken?: unknown;
  expiresAt?: unknown;
}

/** A usable auth token: the 64-char lowercase hex string the Worker issues. */
export function isAuthToken(value: unknown): value is string {
  return isHexId(value);
}

/** A usable token expiry: a finite epoch-ms number above 0. */
export function isExpiresAt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Drop an unusable `authToken` / `expiresAt` from an issued-credentials payload,
 * so a caller reads it exactly as if the server had sent none: no token is stored
 * (the existing no-token path runs), and no expiry means "valid until a 401".
 * Every other field passes through untouched. At most one `console.warn` per
 * payload, only when a PRESENT key was dropped, never carrying the value.
 */
export function sanitizeIssuedCredentials<T extends IssuedCredentialFields>(
  data: T,
): T {
  const { authToken, expiresAt, ...rest } = data;
  const tokenOk = isAuthToken(authToken);
  const expiryOk = isExpiresAt(expiresAt);
  if (
    (authToken !== undefined && !tokenOk) ||
    (expiresAt !== undefined && !expiryOk)
  ) {
    console.warn(
      "[issuedCredentials] ignored an auth token or expiry that is not in the expected format",
    );
  }
  return {
    ...rest,
    ...(tokenOk && { authToken }),
    ...(expiryOk && { expiresAt }),
  } as T;
}

/** A create / join payload typed as a family group: the group's text layer, then the issued
 *  token / expiry check. */
export function sanitizeIssuedFamilyGroup<
  T extends FamilyGroupTextFields & IssuedCredentialFields,
>(group: T): T {
  return sanitizeIssuedCredentials(sanitizeFamilyGroupText(group));
}
