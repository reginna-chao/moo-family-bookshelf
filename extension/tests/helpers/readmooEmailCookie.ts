import { READMOO_EMAIL_COOKIE } from "@/content/pageAccountCookie";

/** Readmoo's login cookie (`ReadmooNext.email`) for jsdom tests (issue #275); the cookie name comes from
 *  production so it cannot drift, and the value format is `encodeReadmooEmail`'s. */

/** `encodeURIComponent(base64(utf8(email)))` — the value Readmoo writes. */
export function encodeReadmooEmail(email: string): string {
  const bytes = new TextEncoder().encode(email);
  return encodeURIComponent(btoa(String.fromCharCode(...bytes)));
}

/** Set the login cookie to an arbitrary raw (already encoded) value. */
export function setRawReadmooEmailCookie(raw: string): void {
  document.cookie = `${READMOO_EMAIL_COOKIE}=${raw}; path=/`;
}

/** Log `email` in on the page, as Readmoo would. */
export function setReadmooEmailCookie(email: string): void {
  setRawReadmooEmailCookie(encodeReadmooEmail(email));
}

/** Log the page out: expire the login cookie (no-op when absent). */
export function clearReadmooEmailCookie(): void {
  document.cookie = `${READMOO_EMAIL_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}
