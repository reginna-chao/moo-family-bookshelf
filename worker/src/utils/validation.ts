import type { VerifyMethod } from "../kv/schema";

const USER_ID_MAX_LENGTH = 128;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidUserId(id: string): boolean {
  return id.length > 0 && id.length <= USER_ID_MAX_LENGTH && USER_ID_PATTERN.test(id);
}

const FAMILY_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

export function isValidFamilyId(id: string): boolean {
  return FAMILY_ID_PATTERN.test(id);
}

const DISPLAY_NAME_MAX_LENGTH = 20;

// Strip zero-width, control, and directional override characters
// eslint-disable-next-line no-control-regex
const UNSAFE_UNICODE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

function cleanDisplayName(raw: string): string {
  return raw.trim().replace(UNSAFE_UNICODE_RE, "");
}

/**
 * Validate and sanitize a display name.
 * Returns the cleaned string. Empty string is allowed.
 */
export function sanitizeDisplayName(name: unknown): string | null {
  if (name === undefined || name === null) return "";
  if (typeof name !== "string") return null;
  const cleaned = cleanDisplayName(name);
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return cleaned;
}

/**
 * Validate a display name for the update endpoint.
 * Returns cleaned string or null if invalid (undefined, null, non-string, or exceeds max length).
 * Empty string is allowed (clears the display name).
 */
export function validateDisplayName(name: unknown): string | null {
  if (name === undefined || name === null || typeof name !== "string") return null;
  const cleaned = cleanDisplayName(name);
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return cleaned;
}

/** Validate 64-char lowercase hex string (SHA-256 output). */
export function isValidSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Validate key fingerprint (SHA-256 hex of encryption key). */
export function isValidKeyFingerprint(value: string): boolean {
  return isValidSha256Hex(value);
}

/**
 * Constant-time equality for equal-length hex strings.
 * Used for comparing keyFingerprint on join to avoid leaking match-prefix
 * via response-time timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const VALID_VERIFY_METHODS: VerifyMethod[] = ["pin", "pattern", "code", "none"];

export function isValidVerifyMethod(method: unknown): method is VerifyMethod {
  return typeof method === "string" && VALID_VERIFY_METHODS.includes(method as VerifyMethod);
}

/** PIN: 6-12 digits only. */
const PIN_PATTERN = /^\d{6,12}$/;

export function isValidPin(value: string): boolean {
  return PIN_PATTERN.test(value);
}

/**
 * Pattern: comma-separated node indices (0-8), at least 4 nodes,
 * no repeats, each value 0-8.
 */
export function isValidPattern(value: string): boolean {
  const parts = value.split(",");
  if (parts.length < 4 || parts.length > 9) return false;
  const seen = new Set<number>();
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isNaN(n) || n < 0 || n > 8 || String(n) !== p) return false;
    if (seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}
