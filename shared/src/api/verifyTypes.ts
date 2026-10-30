/** PWA login verification shapes — `GET` / `PUT /api/user/:id/verify`, the owner-only
 *  `GET /api/user/:id/verify/prompted` and `POST /api/user/:id/verify/otp`. Re-exported by `api/types.ts`. */

import type { BoolFlag } from "./types";

export type VerifyMethod = "pin" | "pattern" | "code" | "none";

export interface VerifyInfo {
  method: VerifyMethod;
}

export interface VerifyPromptedInfo {
  prompted: BoolFlag;
}

export interface SetVerifyBody {
  method: VerifyMethod;
  secret?: string;
  prompted?: BoolFlag;
  /** The account's current PIN / serialized pattern; required while the current method is either (#396). */
  currentSecret?: string;
}

/** Optional `DELETE /api/user/:id` body; `currentSecret` as in `SetVerifyBody` (#396). */
export interface DeleteAccountBody {
  currentSecret?: string;
}

/** `PUT /api/user/:id/verify` result. A new `pin` / `pattern` revokes every auth token of the
 *  account (one per device, #425) and issues `authToken` + `expiresAt` for this device only;
 *  `code` and `none` issue neither. */
export interface SetVerifyResult {
  method: VerifyMethod;
  prompted: BoolFlag;
  authToken?: string;
  expiresAt?: number;
}

export interface OtpInfo {
  code: string;
  expiresAt: number;
}
