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

// Strip zero-width, control, and directional override characters
// eslint-disable-next-line no-control-regex
const UNSAFE_UNICODE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

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
  if (name === undefined || name === null || typeof name !== "string") return null;
  const cleaned = cleanDisplayName(name);
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return cleaned;
}

const READMOO_NAME_MAX_LENGTH = 50;

export function sanitizeShortString(value: unknown, maxLength = READMOO_NAME_MAX_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(UNSAFE_UNICODE_RE, "");
  if (cleaned.length === 0 || cleaned.length > maxLength) return null;
  return cleaned;
}

export function isValidSha256Hex(value: string): boolean {
  return Sha256HexSchema.safeParse(value).success;
}

export function isValidRequestId(value: string): boolean {
  return RequestIdSchema.safeParse(value).success;
}

const VALID_VERIFY_METHODS: VerifyMethod[] = ["pin", "pattern", "code", "none"];

export function isValidVerifyMethod(method: unknown): method is VerifyMethod {
  return typeof method === "string" && VALID_VERIFY_METHODS.includes(method as VerifyMethod);
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

const VALID_EXPIRES_DAYS = [7, 30, 60, 90];

export function isValidExpiresDays(value: unknown): value is number | null {
  if (value === null) return true;
  if (typeof value !== "number") return false;
  return VALID_EXPIRES_DAYS.includes(value);
}
