// URL-fragment parsing for the PWA login entry points (QR `#code=…&uid=…`, invite `#invite=…`).
// Imported by useAuth.ts, so it must never reach constants.ts (#266, useAuthImportChain.test.ts).

import { decodeSyncCode } from "moo-family-bookshelf-shared/crypto/syncCode";
import { PAGE_HASHES } from "@/routes";

export function clearUrlParams(): void {
  // Preserve page routing hashes (#family-shelf, #personal-shelf, #settings);
  // only clear auth-related hashes (#code=…&uid=…, #invite=…) and query params.
  if (PAGE_HASHES.has(window.location.hash)) return;
  if (window.location.hash || window.location.search) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

export interface QrParams {
  syncCode: string;
  userId: string;
  qrToken?: string;
}

export function tryParseQrParams(): QrParams | null {
  // Read from URL fragment (#) — fragments are never sent to the server,
  // keeping the sync code out of access logs and referrer headers.
  const hash = window.location.hash.slice(1); // remove leading #
  const params = new URLSearchParams(hash);
  const code = params.get("code");
  const uid = params.get("uid");
  const qrt = params.get("qrt");

  if (!code || !uid) {
    return null;
  }

  // Validate that the sync code is decodable before returning
  try {
    decodeSyncCode(code);
  } catch {
    console.warn("QR Code 同步碼解析失敗");
    return null;
  }

  return { syncCode: code, userId: uid, qrToken: qrt || undefined };
}

/** Parse #invite={syncCode} from the URL hash (invite link flow): the full sync code when present
 *  and decodable, null otherwise. */
export function tryParseInviteParam(): string | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const code = params.get("invite");
  if (!code) return null;

  // Validate that the sync code is decodable
  try {
    decodeSyncCode(code);
  } catch {
    console.warn("邀請連結同步碼解析失敗");
    return null;
  }
  return code;
}
