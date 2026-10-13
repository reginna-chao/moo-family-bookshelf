/** PWA login verification shapes — `GET` / `PUT /api/user/:id/verify` and
 *  `POST /api/user/:id/verify/otp`. Re-exported by `api/types.ts`. */

export type VerifyMethod = "pin" | "pattern" | "code" | "none";

export interface VerifyInfo {
  method: VerifyMethod;
  prompted: number;
}

export interface SetVerifyBody {
  method: VerifyMethod;
  secret?: string;
  prompted?: number;
}

export interface OtpInfo {
  code: string;
  expiresAt: number;
}
