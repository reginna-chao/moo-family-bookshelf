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
