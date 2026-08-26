import { isAllowedCoverUrl } from "moo-family-bookshelf-shared/config/readmoo";
import type { VerifyMethod } from "../kv/schema";
import {
  UserIdSchema,
  Sha256HexSchema,
  FamilyIdSchema,
  RequestIdSchema,
  ShareTokenSchema,
  PinSchema,
} from "../schemas/common";

export function isValidUserId(id: string): boolean {
  return UserIdSchema.safeParse(id).success;
}

export function isValidFamilyId(id: string): boolean {
  return FamilyIdSchema.safeParse(id).success;
}

export const DISPLAY_NAME_MAX_LENGTH = 20;

// Strip zero-width, control, and directional override characters. Prettier
// breaks this declaration across two lines, so an `eslint-disable-next-line`
// would land on the `const` instead of the literal — hence the block form.
/* eslint-disable no-control-regex */
const UNSAFE_UNICODE_RE =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/* eslint-enable no-control-regex */

function cleanDisplayName(raw: string): string {
  return raw.trim().replace(UNSAFE_UNICODE_RE, "");
}

export function sanitizeDisplayName(name: unknown): string | null {
  if (name === undefined || name === null) return "";
  if (typeof name !== "string") return null;
  const cleaned = cleanDisplayName(name);
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return cleaned;
}

export function validateDisplayName(name: unknown): string | null {
  if (name === undefined || name === null || typeof name !== "string")
    return null;
  const cleaned = cleanDisplayName(name);
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return cleaned;
}

const READMOO_NAME_MAX_LENGTH = 50;

export function sanitizeShortString(
  value: unknown,
  maxLength = READMOO_NAME_MAX_LENGTH,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(UNSAFE_UNICODE_RE, "");
  if (cleaned.length === 0 || cleaned.length > maxLength) return null;
  return cleaned;
}

/**
 * Upper bound for a `verifySecret` submitted to the verification gate. Every
 * real secret is far shorter (PIN ≤ 12 digits, pattern ≤ 17 chars, OTP = 6
 * digits); the bound exists so an oversized string can never reach the hash
 * step.
 */
export const VERIFY_SECRET_MAX_LENGTH = 256;

/**
 * Normalize a `verifySecret` taken from a request body, following the same
 * convention as {@link sanitizeDisplayName}:
 *
 * - `""`   — no secret supplied (absent, `null`, or an empty string). No attempt
 *            was made, so the caller must not charge anything for it.
 * - `null` — present but malformed: not a string, or longer than
 *            {@link VERIFY_SECRET_MAX_LENGTH}. The caller must answer 400.
 * - otherwise the secret itself, unmodified (a PIN/pattern/OTP is compared
 *   byte-for-byte, so trimming or stripping characters here would silently
 *   change what the user typed).
 *
 * Lives at the boundary so all three entry points of the gate (`POST
 * /api/family`, `POST /api/family/:id/join`, `POST /api/auth/lookup`) classify
 * the same input identically.
 */
export function sanitizeVerifySecret(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  if (value.length > VERIFY_SECRET_MAX_LENGTH) return null;
  return value;
}

/**
 * Keep a coverUrl only when it is empty (scraper placeholder) or on the
 * Readmoo cover-host whitelist; anything else is blanked to "". Sanitize
 * instead of reject: one attacker-crafted cover in a sync payload must not
 * fail the whole books sync, and a blanked cover renders as the normal
 * no-cover state. Off-whitelist covers would otherwise act as tracking
 * beacons against family members and public-shelf visitors.
 *
 * Lives at the boundary so all three consumer groups scrub identically:
 *
 * - the books write paths in `routes/user.ts` (PUT sync, PATCH rebuild, and the
 *   family-prefs rebuild), which keep fresh poison out of `user:{id}` and
 *   lazily scrub whatever a pre-whitelist write left there;
 * - `buildSnapshot` in `services/publicShelf.ts`, the chokepoint every
 *   `public:{shareToken}` snapshot writer funnels through;
 * - the family bookshelf aggregation in `routes/bookshelf.ts`, which sanitizes
 *   again at READ time. The write paths alone do NOT protect that surface: a
 *   record poisoned before the whitelist existed keeps its value until that
 *   account's next real write, and a dormant account may never make one.
 */
export function sanitizeCoverUrl(value: unknown): string {
  const url = typeof value === "string" ? value : "";
  return url === "" || isAllowedCoverUrl(url) ? url : "";
}

/**
 * Narrow a `JSON.parse`-produced value to a keyed record.
 *
 * `JSON.parse` yields only objects, arrays, and primitives, so rejecting
 * `null`, arrays, and non-objects leaves exactly the plain-object case. Use it
 * before any `key in body` check at a handler boundary: `in` throws a
 * TypeError on a truthy primitive (`5`, `"x"`, `true`), which would surface as
 * a 500 instead of a clean 400.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidSha256Hex(value: string): boolean {
  return Sha256HexSchema.safeParse(value).success;
}

export function isValidRequestId(value: string): boolean {
  return RequestIdSchema.safeParse(value).success;
}

const VALID_VERIFY_METHODS: VerifyMethod[] = ["pin", "pattern", "code", "none"];

export function isValidVerifyMethod(method: unknown): method is VerifyMethod {
  return (
    typeof method === "string" &&
    VALID_VERIFY_METHODS.includes(method as VerifyMethod)
  );
}

export function isValidPin(value: string): boolean {
  return PinSchema.safeParse(value).success;
}

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

export function isValidShareToken(value: unknown): value is string {
  return typeof value === "string" && ShareTokenSchema.safeParse(value).success;
}

const PUBLIC_SHELF_TITLE_MAX_LENGTH = 60;

export function sanitizePublicShelfTitle(value: unknown): string | null {
  return sanitizeShortString(value, PUBLIC_SHELF_TITLE_MAX_LENGTH);
}

// "{ownerId}:{bookId}" — 64-char lowercase SHA-256 hex ownerId, ':' separator, non-empty bookId.
const FAMILY_PREF_REF_RE = /^[0-9a-f]{64}:.+$/;

export function isValidFamilyPrefRef(s: string): boolean {
  return FAMILY_PREF_REF_RE.test(s);
}

const VALID_EXPIRES_DAYS = [7, 30, 60, 90];

export function isValidExpiresDays(value: unknown): value is number | null {
  if (value === null) return true;
  if (typeof value !== "number") return false;
  return VALID_EXPIRES_DAYS.includes(value);
}
