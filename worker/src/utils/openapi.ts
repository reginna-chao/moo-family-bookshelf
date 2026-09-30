import { z } from "@hono/zod-openapi";
import type { Context, ValidationTargets } from "hono";
import { jsonError } from "./errors";
import { paramErrorFor } from "../schemas/common";

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

/** The slice of zod-validator's hook result this hook reads. */
interface ValidationResult {
  target: keyof ValidationTargets;
  success: boolean;
  error?: { issues: ReadonlyArray<{ message: string }> };
}

/**
 * The copy for a failed validation. A `param` failure whose FIRST issue carries
 * a registered tag (`taggedParam` in `schemas/common.ts`) answers that tag's
 * route-specific code + message; every other failure — including an untagged
 * param schema — falls back to the generic per-target copy.
 */
function errorCopyFor(result: ValidationResult): ValidationErrorCopy {
  if (result.target === "param") {
    const tag = result.error?.issues[0]?.message;
    const tagged = tag === undefined ? null : paramErrorFor(tag);
    if (tagged) return tagged;
  }
  return validationErrorFor(result.target);
}

/**
 * `defaultHook` shared by every OpenAPIHono sub-app: turns a failed zod
 * validation into the standard `{ error: { code, message } }` 400.
 *
 * Path params: the route schemas are the single source of param format
 * validation (#227). Each field is tagged with the code the handler used to
 * answer (INVALID_FAMILY_ID / INVALID_USER_ID / INVALID_SHELF_ID /
 * INVALID_REQUEST_ID / INVALID_TOKEN — see `schemas/common.ts`), so the
 * response is byte-identical to the former handler check; the first failing
 * param decides, following the schema's key order. An untagged param schema
 * answers INVALID_PARAMS.
 *
 * Every other target is coded by `result.target` (json → INVALID_FIELDS,
 * query → INVALID_QUERY, anything else → INVALID_REQUEST) and is unreachable
 * today: no route declares a body / query / header schema, so request bodies
 * are still validated by the HANDLERS with their own codes (INVALID_JSON,
 * INVALID_FIELDS …). Moving body validation into the schemas is tracked in
 * #239.
 *
 * Only registry copy or the generic copy is ever returned — zod's issue list,
 * and with it any caller-supplied value, is never echoed.
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
  result: ValidationResult,
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const { code, message } = errorCopyFor(result);
  return jsonError(c, 400, code, message);
};
