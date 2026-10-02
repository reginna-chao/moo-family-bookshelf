import type { ApiErrorPayload } from "../api/types";
import { safeErrorText } from "../api/safeErrorText";

/** Error code the Worker answers when an upload body exceeds its size cap. */
const PAYLOAD_TOO_LARGE_CODE = "PAYLOAD_TOO_LARGE";

/**
 * Shown when the server refuses a personal-books upload as too large. The
 * Worker's own `message` names a byte limit ("Request body exceeds …KB"),
 * which means nothing to a reader; a family on an older self-hosted Worker
 * hits a far lower cap than the current one, hence the update hint.
 */
export const BOOKS_TOO_LARGE_MESSAGE =
  "書太多了，伺服器沒辦法一次存下整份書單。如果家庭用的是自架伺服器，請管理者把伺服器更新到最新版。";

/** Error code the Worker answers when an upload's `expectedLastUpdated` no longer matches the stored list. */
export const BOOKS_CONFLICT_CODE = "BOOKS_CONFLICT";

/** Shown when a sync gave up after the list kept changing elsewhere; only the Extension sync sends the precondition. */
export const BOOKS_CONFLICT_MESSAGE =
  "書單剛在別的地方改過，這次同步已停止。請稍後再同步一次。";

/**
 * Display text for an error returned by a personal-books upload (save or
 * sync), shared by Extension and PWA so both show the same copy.
 *
 * `error` comes from an unvalidated envelope cast, so its fields may be any
 * type at runtime: the strict `===` on `code` is safe for any value, and every
 * other case goes through `safeErrorText` exactly as the call sites did before.
 */
export function booksSaveErrorText(
  error: Pick<ApiErrorPayload, "code" | "message">,
  fallback: string,
): string {
  if (error.code === PAYLOAD_TOO_LARGE_CODE) {
    return BOOKS_TOO_LARGE_MESSAGE;
  }
  if (error.code === BOOKS_CONFLICT_CODE) {
    return BOOKS_CONFLICT_MESSAGE;
  }
  return safeErrorText(error.message, fallback);
}
