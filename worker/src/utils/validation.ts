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

/**
 * Validate and sanitize a display name.
 * Returns the trimmed string. Empty string is allowed.
 */
export function sanitizeDisplayName(name: unknown): string | null {
  if (name === undefined || name === null) return "";
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Validate a display name for the update endpoint.
 * Returns trimmed string or null if invalid (undefined, null, non-string, or exceeds max length).
 * Empty string is allowed (clears the display name).
 */
export function validateDisplayName(name: unknown): string | null {
  if (name === undefined || name === null || typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) return null;
  return trimmed;
}
