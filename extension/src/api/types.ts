/**
 * Shared types, interfaces, and enums for the API layer.
 */

/**
 * The wire contract itself — the `{ data, error }` envelope, `BoolFlag`, the
 * family / bookshelf / borrow records, the `POST /api/auth/lookup` payload,
 * the thrown `ApiError`, the personal-books record, the `/api/version` and
 * `/api/user/:id/verify*` shapes, the member-settings payload, the un-kick
 * result and the public-shelf records — lives in `shared/` so the Extension
 * and the PWA cannot describe the same payload differently. Re-exported here
 * because every existing importer reaches for these names through the API
 * layer — new code outside `api/` should import the shared modules directly
 * rather than routing through this file. Nothing in this file is declared in
 * terms of them any more, so every name is a plain re-export; the only
 * app-local declaration left is `AUTH_REFRESH_RATE_LIMITED` below.
 */
export {
  ApiError,
  BoolFlag,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "moo-family-bookshelf-shared/api/types";
export type {
  ApiErrorPayload,
  ApiResponse,
  BookEntry,
  FamilyBookshelf,
  FamilyBookshelfMember,
  FamilyGroup,
  FamilyMember,
  LookupResult,
  MemberSettingsPayload,
  OtpInfo,
  PersonalBooks,
  PublicShelf,
  PublicShelfData,
  SelectionMode,
  SetVerifyBody,
  UnkickResult,
  VerifyInfo,
  VerifyMethod,
  VersionInfo,
} from "moo-family-bookshelf-shared/api/types";
export { BorrowStatus } from "moo-family-bookshelf-shared/borrow/types";
export type {
  BorrowRequest,
  CreateBorrowPayload,
} from "moo-family-bookshelf-shared/borrow/types";

/**
 * Client-synthesized code for a 401 whose silent token recovery was itself
 * rate-limited. Distinct from the server's `RATE_LIMITED` on purpose: its
 * message is bespoke 繁體中文 guidance («請重新開啟書櫃») that the generic
 * back-off copy cannot reconstruct, so the UI passes it through verbatim.
 *
 * The code alone is NOT sufficient authority for that passthrough — any backend
 * can put this string in an envelope. `ApiError.synthesized` is the check.
 */
export const AUTH_REFRESH_RATE_LIMITED = "AUTH_REFRESH_RATE_LIMITED";
