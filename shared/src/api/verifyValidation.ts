/** Structure layer for `GET /api/user/:id/verify`: only one of the four known methods survives.
 *  Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import type { ApiResponse } from "./types";
import type { VerifyMethod } from "./verifyTypes";

// A Set, never an object-literal lookup: `"__proto__"` / `"toString"` must not read as a method.
const VERIFY_METHODS: ReadonlySet<string> = new Set<VerifyMethod>([
  "pin",
  "pattern",
  "code",
  "none",
]);

/** Reject primitives, `null`, and arrays; only a plain object can carry `method`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerifyMethod(value: unknown): value is VerifyMethod {
  return typeof value === "string" && VERIFY_METHODS.has(value);
}

/**
 * Validate a `GET /api/user/:id/verify` envelope at the API boundary.
 *
 * A usable `data` is a plain object whose `method` is exactly `"pin"`,
 * `"pattern"`, `"code"` or `"none"`; it is rebuilt as `{ method }` alone, so no
 * other server field (e.g. a stale server's `prompted`) reaches a caller.
 * Anything else becomes a fresh `INVALID_RESPONSE` error envelope with no
 * `data`, so every caller's `res.data?.method` reads as missing: the PWA login
 * falls back to a plain join (the server still decides) instead of opening a
 * verify screen with no input and no cancel. An `error` is forwarded alone (the
 * same object, any `data` beside it dropped, since callers read `data` before
 * `error`); a missing or `null` `data` passes through untouched. At most one
 * `console.warn` per response, never carrying the value.
 */
export function sanitizeVerifyInfoResponse<T>(
  res: ApiResponse<unknown>,
): ApiResponse<T> {
  // Truthiness (a BYO `error: null` must not skip validation); `data` is dropped because these
  // callers read it before `error` — docs/architecture.md → 伺服器回傳資料的檢查.
  if (res.error) return { error: res.error } as ApiResponse<T>;
  if (res.data === undefined || res.data === null) return res as ApiResponse<T>;

  const data = res.data;
  const method = isRecord(data) ? data.method : undefined;
  if (isVerifyMethod(method)) {
    return { ...res, data: { method } as unknown as T };
  }

  console.warn(
    "[verifyValidation] ignored a verify response whose method is not a known value",
  );
  return {
    error: {
      code: "INVALID_RESPONSE",
      message: "response is not a valid verify method",
    },
  };
}
