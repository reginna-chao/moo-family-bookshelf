const USER_ID_MAX_LENGTH = 128;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidUserId(id: string): boolean {
  return id.length > 0 && id.length <= USER_ID_MAX_LENGTH && USER_ID_PATTERN.test(id);
}

const FAMILY_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

export function isValidFamilyId(id: string): boolean {
  return FAMILY_ID_PATTERN.test(id);
}
