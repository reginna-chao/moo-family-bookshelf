// The page's Readmoo account, read from Readmoo's login cookie (issue #275). The badge confirms
// with it; the Dialog's pre-sync check (dialog/accountIdentityCheck.ts) may only VETO with it.

import { compareAccountIdentity } from "./accountIdentity";

/**
 * Readmoo's cookie carrying the logged-in account's email, as
 * `encodeURIComponent(base64(email))`; absent when logged out. Observed on
 * next.readmoo.com (docs/architecture.md → 讀墨帳號確認（已加入家庭時）).
 */
export const READMOO_EMAIL_COOKIE = "ReadmooNext.email";

/** RFC 5321's 256-octet path minus its `<>`; anything longer is not an email. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every value `document.cookie` lists under `name` (one per cookie path). */
function cookieValues(cookieString: string, name: string): string[] {
  const values: string[] = [];
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/** Base64 → UTF-8 text; throws on bad base64 or bytes that are not UTF-8. */
function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeEmail(raw: string): string | null {
  try {
    const email = decodeBase64Utf8(decodeURIComponent(raw)).trim();
    if (email.length > MAX_EMAIL_LENGTH) return null;
    return EMAIL_SHAPE.test(email) ? email : null;
  } catch {
    return null;
  }
}

/**
 * Pure parser behind {@link readPageAccountEmail}: the logged-in email in a
 * `document.cookie` string, or `null` when the cookie is absent, undecodable,
 * not shaped like an email, or listed twice with different values (ambiguous).
 */
export function parsePageAccountEmail(cookieString: string): string | null {
  const values = [...new Set(cookieValues(cookieString, READMOO_EMAIL_COOKIE))];
  const [raw] = values;
  if (values.length !== 1 || raw === undefined) return null;
  return decodeEmail(raw);
}

/**
 * The email of the Readmoo account logged in on this page, or `null` when it
 * cannot be told from the cookie. No navigation, nothing stored, never throws:
 * the page can write any cookie, so every unusable value is `null`.
 */
export function readPageAccountEmail(): string | null {
  try {
    return parsePageAccountEmail(document.cookie);
  } catch {
    return null;
  }
}

/**
 * True only when the login cookie names the account `storedUserId` was derived
 * from. `false` covers another account, no usable cookie and a hashing failure
 * alike — the cookie can confirm the stored user, never refute it. Never rejects.
 */
export async function cookieConfirmsAccount(
  storedUserId: string,
): Promise<boolean> {
  try {
    const email = readPageAccountEmail();
    return (await compareAccountIdentity(email, storedUserId)) === "match";
  } catch {
    return false;
  }
}
