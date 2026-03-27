const USER_ID_MAX_LENGTH = 128;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidUserId(id: string): boolean {
  return id.length > 0 && id.length <= USER_ID_MAX_LENGTH && USER_ID_PATTERN.test(id);
}
