import { z } from "@hono/zod-openapi";

// Format patterns, shared by the plain schemas (`isValid*` body checks in utils/validation.ts) and the
// tagged path-param fields below, so a body check and a param check can never disagree.
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const FAMILY_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
// No /i flag: zod-to-openapi would leave a literal "/i" in the OpenAPI pattern. The classes spell
// out case-insensitivity — same match set as the former /…/i.
const REQUEST_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export const Sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);
// userIds are email-derived SHA-256 hex (shared/src/crypto/hash.ts): the strict 64-hex rule applies
// everywhere — there is no legitimate non-hex userId.
export const UserIdSchema = Sha256HexSchema;
export const FamilyIdSchema = z.string().regex(FAMILY_ID_PATTERN);
export const RequestIdSchema = z.string().regex(REQUEST_ID_PATTERN);
export const ShareTokenSchema = z.string().regex(SHARE_TOKEN_PATTERN);
export const PinSchema = z.string().regex(/^\d{6,12}$/);

/** Malformed-path-param copy by code: the exact pairs the handlers answered with before #227. API contract —
 *  never reword (.claude/rules/backend.md → API Design). */
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

/** Path-param field whose zod issue message IS `code`, resolved by `defaultHook` (utils/openapi.ts) via
 *  `paramErrorFor`. A matched route's params are always strings, so only the regex can fail. */
function taggedParam(pattern: RegExp, code: ParamErrorCode) {
  return z.string().regex(pattern, { error: code });
}

const familyIdParam = taggedParam(FAMILY_ID_PATTERN, "INVALID_FAMILY_ID");
const userIdParam = taggedParam(SHA256_HEX_PATTERN, "INVALID_USER_ID");

// Path-param objects (`id` is a familyId or a userId by route). KEY ORDER IS LOAD-BEARING: the first
// malformed key's code wins. See .claude/rules/backend.md → API Design.
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
