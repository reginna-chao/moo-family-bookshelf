/** Thin data access (#163) for `verify:{userId}`, `otp:{userId}`, `qr:{token}` — route handlers only;
 *  the verification gate keeps its own KV calls. See docs/architecture.md → 2.5 Cloudflare KV Store. */
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
