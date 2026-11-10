/** Type-only half of `client.ts`'s wire-contract re-exports (rationale in its comment above
 *  `export type * from "./clientTypes"`); split out for the max-lines ceiling. */

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
export type {
  BorrowRequest,
  CreateBorrowPayload,
} from "moo-family-bookshelf-shared/borrow/types";
