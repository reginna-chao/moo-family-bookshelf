import { z } from "@hono/zod-openapi";

// Format patterns. Each is shared by the plain format schema below (used by the
// `isValid*` helpers in utils/validation.ts for body fields) and by the tagged
// path-param fields further down, so a body check and a param check can never
// disagree about what a well-formed id looks like.
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const FAMILY_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
// No /i flag: zod-to-openapi emits `regex.toString()` minus the slashes and would
// leave a literal "/i" in the OpenAPI pattern. Case-insensitivity is spelled out
// in the classes instead — match set identical to the former /…/i.
const REQUEST_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export const Sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);
// userIds are SHA-256 hex digests derived from the account email (see
// shared/src/crypto/hash.ts). Enforce the strict 64-hex rule everywhere,
// matching the auth routes' Sha256HexSchema — there is no legitimate
// non-hex userId.
export const UserIdSchema = Sha256HexSchema;
export const FamilyIdSchema = z.string().regex(FAMILY_ID_PATTERN);
export const RequestIdSchema = z.string().regex(REQUEST_ID_PATTERN);
export const ShareTokenSchema = z.string().regex(SHARE_TOKEN_PATTERN);
export const PinSchema = z.string().regex(/^\d{6,12}$/);

/**
 * Error copy for a malformed path parameter, keyed by error code. These are the
 * exact `{ code, message }` pairs the route handlers answered with before path
 * validation moved into the route schemas (#227) — part of the API contract,
 * so they are not to be reworded.
 */
const PARAM_ERROR_MESSAGES = {
  INVALID_FAMILY_ID: "Family ID format is invalid",
  INVALID_USER_ID: "userId format is invalid",
  INVALID_SHELF_ID: "shelfId format is invalid",
  INVALID_REQUEST_ID: "Request ID format is invalid",
  INVALID_TOKEN: "Invalid share token format",
} as const;

type ParamErrorCode = keyof typeof PARAM_ERROR_MESSAGES;

export interface ParamErrorCopy {
  code: ParamErrorCode;
  message: string;
}

/**
 * The error copy a tagged param field stands for, or `null` when `tag` is not a
 * registered code (an untagged schema, or zod's own default message). Own-key
 * lookup only, so an inherited name such as `constructor` never matches.
 */
export function paramErrorFor(tag: string): ParamErrorCopy | null {
  if (!Object.hasOwn(PARAM_ERROR_MESSAGES, tag)) return null;
  const code = tag as ParamErrorCode;
  return { code, message: PARAM_ERROR_MESSAGES[code] };
}

/**
 * A path-param field whose failure is tagged with `code`: the zod issue's
 * message IS the code, which `defaultHook` (utils/openapi.ts) resolves back to
 * the registered `{ code, message }` via `paramErrorFor`. Path params are always
 * strings on a matched route, so the regex is the only check that can fail.
 */
function taggedParam(pattern: RegExp, code: ParamErrorCode) {
  return z.string().regex(pattern, { error: code });
}

const familyIdParam = taggedParam(FAMILY_ID_PATTERN, "INVALID_FAMILY_ID");
const userIdParam = taggedParam(SHA256_HEX_PATTERN, "INVALID_USER_ID");

// Path-param objects. `id` names a familyId on the family / bookshelf / borrow
// routes and a userId on the user / verify / public-shelf routes, hence the
// separate objects. KEY ORDER IS LOAD-BEARING: zod reports issues in schema key
// order and `defaultHook` answers the FIRST one, so when several params are
// malformed the code is that of the first key — keep it matching the order the
// handlers used to check them in.
export const FamilyIdParam = z.object({ id: familyIdParam });
export const UserIdParam = z.object({ id: userIdParam });
export const FamilyMemberParams = z.object({
  id: familyIdParam,
  uid: userIdParam,
});
export const UserShelfParams = z.object({
  id: userIdParam,
  shelfId: taggedParam(REQUEST_ID_PATTERN, "INVALID_SHELF_ID"),
});
export const RequestIdParam = z.object({
  requestId: taggedParam(REQUEST_ID_PATTERN, "INVALID_REQUEST_ID"),
});
export const ShareTokenParam = z.object({
  shareToken: taggedParam(SHARE_TOKEN_PATTERN, "INVALID_TOKEN"),
});
