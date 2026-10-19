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

/** Error code the Worker answers when an upload body is malformed or breaks a cap (book count, a field's length). */
const INVALID_PAYLOAD_CODE = "INVALID_PAYLOAD";

/** Shown when the server refuses a personal-books upload as malformed; generic, as that code covers several checks. */
export const BOOKS_INVALID_PAYLOAD_MESSAGE =
  "書單裡有伺服器不接受的資料，這次沒有存進去。請把擴充功能或 PWA 更新到最新版再試一次。";

/** Error code the Worker answers when an upload's `expectedLastUpdated` no longer matches the stored list. */
export const BOOKS_CONFLICT_CODE = "BOOKS_CONFLICT";

/** Shown when a sync (Extension sync or onboarding first sync) gave up after the list kept changing elsewhere. */
export const BOOKS_CONFLICT_MESSAGE =
  "書單剛在別的地方改過，這次同步已停止。請稍後再同步一次。";

/** Shown when a personal-shelf Save gave up after the list kept changing elsewhere; the unsaved changes stay on screen. */
export const BOOKS_SAVE_CONFLICT_MESSAGE =
  "書單剛在別的地方改過，這次沒有存進去。請稍後再按一次儲存。";

/**
 * Display text for an error returned by a personal-books upload (save or
 * sync), shared by Extension and PWA so both show the same copy.
 * `conflictMessage` is the `BOOKS_CONFLICT` copy: the sync wording by default,
 * `BOOKS_SAVE_CONFLICT_MESSAGE` for a Save. `PAYLOAD_TOO_LARGE` and
 * `INVALID_PAYLOAD` get fixed 繁中 copy, never the Worker's English `message`.
 *
 * `error` comes from an unvalidated envelope cast, so its fields may be any
 * type at runtime: the strict `===` on `code` is safe for any value, and every
 * other case goes through `safeErrorText` exactly as the call sites did before.
 */
export function booksSaveErrorText(
  error: Pick<ApiErrorPayload, "code" | "message">,
  fallback: string,
  conflictMessage = BOOKS_CONFLICT_MESSAGE,
): string {
  if (error.code === PAYLOAD_TOO_LARGE_CODE) {
    return BOOKS_TOO_LARGE_MESSAGE;
  }
  if (error.code === INVALID_PAYLOAD_CODE) {
    return BOOKS_INVALID_PAYLOAD_MESSAGE;
  }
  if (error.code === BOOKS_CONFLICT_CODE) {
    return conflictMessage;
  }
  return safeErrorText(error.message, fallback);
}
