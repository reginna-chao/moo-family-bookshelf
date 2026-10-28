/** RFC 5321's 256-octet path minus its `<>`; anything longer is not an email. */
export const MAX_EMAIL_LENGTH = 254;

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether `text` may go to `deriveUserId` as an account email: at most
 * {@link MAX_EMAIL_LENGTH} characters and shaped like `local@domain.tld`.
 * The one rule shared by the Extension's `#/me` scraper and login-cookie
 * parser and the PWA login form. No trimming and no case folding — callers
 * pass the text they would hash.
 */
export function isEmailShaped(text: string): boolean {
  return text.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(text);
}
