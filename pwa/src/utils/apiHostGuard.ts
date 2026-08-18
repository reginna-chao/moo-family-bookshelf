import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";

/** Shown when a sync code's `@host` is one the API client refuses to adopt. */
export const UNSAFE_API_HOST_ERROR =
  "此同步碼的伺服器位址無效或不安全，無法加入。";

/**
 * True when a sync code's `@host` would be REFUSED by `validateEndpointUrl`.
 *
 * Every path that would talk to that host must check first: the join client is
 * built from this value, so an unchecked reject means the PWA has already sent
 * a verify-method probe (and then an auth token) to an address the security
 * rules exist to keep it away from. Never adopt, never persist.
 */
export function isUnsafeApiHost(apiHost: string | undefined): boolean {
  return classifySyncCodeApiHost(apiHost).kind === "invalid";
}
