/**
 * Data access for the verification key family: `verify:{userId}`,
 * `otp:{userId}` and `qr:{token}`.
 *
 * WHY this module exists (#163): one chokepoint per key family, so route
 * handlers never build a KV key or call `c.env.KV` themselves (lint-enforced by
 * the `src/routes/**` override in `worker/eslint.config.js`). Thin by design —
 * one KV operation per function, `"json"` reads keep their unvalidated cast
 * (`VerifyRecord.secretUpdatedAt` is optional precisely because nothing
 * validates these casts), puts keep `JSON.stringify` and their fixed TTLs, and
 * the counting Proxy from `middleware/kvOpCounting.ts` flows through as the
 * `kv` parameter, so the per-request `kv_ops` accounting is unchanged.
 *
 * SCOPE: route handlers — `routes/verify.ts` for all three key families, plus
 * `routes/family.ts`, whose join handler reads and then consumes a QR token
 * (`getQrTokenRecord` / `deleteQrToken`) on the QR-bypass path. The verification
 * GATE (`services/verification.ts`) keeps its own reads of `verify:{userId}`,
 * `otp:{userId}` and `verifyfail:{userId}:{caller}` — a service may touch KV
 * directly, and its OTP read is paired with a conditional consume that is part
 * of the gate's logic, not of this accessor layer. `verifyfail:*` has no
 * accessor here for the same reason: it is written only inside the gate.
 */
import {
  kvKeys,
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  type OtpRecord,
  type QrTokenRecord,
  type VerifyRecord,
} from "./schema";

/**
 * Read `verify:{userId}` — PWA login verification settings. Persistent, no TTL.
 * `null` means the account has never configured verification.
 */
export async function getVerifyRecord(
  kv: KVNamespace,
  userId: string,
): Promise<VerifyRecord | null> {
  return kv.get<VerifyRecord>(kvKeys.verify(userId), "json");
}

/** Write `verify:{userId}` as JSON. No TTL. */
export async function putVerifyRecord(
  kv: KVNamespace,
  userId: string,
  record: VerifyRecord,
): Promise<void> {
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

/**
 * Write the one-time code `otp:{userId}` with TTL `OTP_TTL_SECONDS` (300s).
 * The TTL is the only expiry — nothing sweeps these keys.
 */
export async function putOtpRecord(
  kv: KVNamespace,
  userId: string,
  record: OtpRecord,
): Promise<void> {
  await kv.put(kvKeys.otp(userId), JSON.stringify(record), {
    expirationTtl: OTP_TTL_SECONDS,
  });
}

/**
 * Read `qr:{token}` — the one-time QR login bypass record. TTL
 * `QR_TOKEN_TTL_SECONDS` (300s) is set by the writer, so `null` covers both
 * "expired" and "never existed"; the join handler treats them the same.
 */
export async function getQrTokenRecord(
  kv: KVNamespace,
  token: string,
): Promise<QrTokenRecord | null> {
  return kv.get<QrTokenRecord>(kvKeys.qrToken(token), "json");
}

/** Write `qr:{token}` with TTL `QR_TOKEN_TTL_SECONDS` (300s). */
export async function putQrTokenRecord(
  kv: KVNamespace,
  token: string,
  record: QrTokenRecord,
): Promise<void> {
  await kv.put(kvKeys.qrToken(token), JSON.stringify(record), {
    expirationTtl: QR_TOKEN_TTL_SECONDS,
  });
}

/** Delete `qr:{token}` — the one-time consume on a successful QR join. */
export async function deleteQrToken(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  await kv.delete(kvKeys.qrToken(token));
}
