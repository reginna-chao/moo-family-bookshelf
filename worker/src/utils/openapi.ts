import { z } from "@hono/zod-openapi";
import type { Context, ValidationTargets } from "hono";
import { jsonError } from "./errors";

export function jsonRes(description: string) {
  return {
    content: { "application/json": { schema: z.any() } },
    description,
  };
}

interface ValidationErrorCopy {
  code: string;
  message: string;
}

/**
 * Error code + message for a schema-validation failure, chosen by the part of
 * the request the failing schema was validating. Deliberately generic: zod's
 * issue list is never echoed back, so no caller-supplied value is reflected.
 */
function validationErrorFor(
  target: keyof ValidationTargets,
): ValidationErrorCopy {
  switch (target) {
    case "json":
      return {
        code: "INVALID_FIELDS",
        message: "Request body fields are invalid",
      };
    case "param":
      return { code: "INVALID_PARAMS", message: "Path parameters are invalid" };
    case "query":
      return {
        code: "INVALID_QUERY",
        message: "Query parameters are invalid",
      };
    default:
      return { code: "INVALID_REQUEST", message: "Request is invalid" };
  }
}

/**
 * `defaultHook` shared by every OpenAPIHono sub-app: turns a failed zod
 * validation into the standard `{ error: { code, message } }` 400, coded by
 * `result.target` (json → INVALID_FIELDS, param → INVALID_PARAMS,
 * query → INVALID_QUERY, anything else → INVALID_REQUEST).
 *
 * Unreachable today. Route schemas carry OpenAPI docs only — each declares at
 * most `params`, whose fields are bare `z.string()` (`schemas/common.ts` plus
 * inline objects in `routes/family.ts`), which cannot fail on a matched path —
 * so the HANDLERS are the single source of format validation, with their own
 * codes (INVALID_FAMILY_ID / INVALID_USER_ID / INVALID_JSON …). Moving that
 * validation into the schemas is tracked in #227.
 *
 * Caveat for whoever adds the first `request.body` JSON schema: this hook does
 * NOT see an unparsable body. Hono's validator (`hono/validator`) throws
 * `HTTPException(400, "Malformed JSON in request body")` before zod runs, and
 * zod-openapi's media-type gate throws `HTTPException(415)` for a mismatched
 * Content-Type. Both bubble to the root `app.onError` in `index.ts`, which
 * today answers every thrown error with `500 INTERNAL_ERROR` — so that route
 * would need an explicit HTTPException mapping (keeping INVALID_JSON for real
 * parse failures) to preserve the handlers' current 400 contract.
 */
export const defaultHook = (
  result: { target: keyof ValidationTargets; success: boolean },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const { code, message } = validationErrorFor(result.target);
  return jsonError(c, 400, code, message);
};
