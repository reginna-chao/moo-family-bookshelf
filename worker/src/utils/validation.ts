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

const READMOO_NAME_MAX_LENGTH = 50;

/**
 * Sanitize an arbitrary short string (e.g. readmooName).
 * Strips zero-width / control / directional override characters and trims whitespace.
 * Returns the cleaned string, or null if invalid (non-string, empty after cleaning, or exceeds max length).
 */
export function sanitizeShortString(value: unknown, maxLength = READMOO_NAME_MAX_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(UNSAFE_UNICODE_RE, "");
  if (cleaned.length === 0 || cleaned.length > maxLength) return null;
  return cleaned;
}

/** Validate 64-char lowercase hex string (SHA-256 output). */
export function isValidSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** UUID v4 format check for borrow request IDs. */
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
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
