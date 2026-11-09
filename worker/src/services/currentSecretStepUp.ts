import type { Context, TypedResponse } from "hono";
import type { Env } from "../utils/env";
import { jsonError, type ErrorBody } from "../utils/errors";
import { isJsonObject, sanitizeVerifySecret } from "../utils/validation";
import { getVerifyRecord } from "../kv/verify";
import { getPresentedAuthToken } from "../middleware/auth";
import { readPresentedAuth } from "./authRecord";
import {
  enforceCurrentSecret,
  verifySecretFormatResponse,
} from "./verification";

/**
 * Message of the step-up's no-secret `403 VERIFICATION_REQUIRED` on self-leave and
 * ownership transfer: a client from before these routes asked for the current secret
 * shows the server message as-is, so it tells that user to update. Never applied to
 * the stale-record refusal, which an update cannot resolve.
 */
export const STEP_UP_UPDATE_REQUIRED_MESSAGE =
  "這個操作需要先輸入目前的 PIN 碼或圖形，請更新擴充功能或 PWA 後再試一次。";

/**
 * Read an optional JSON body `{ currentSecret? }` (#396) for a handler whose body
 * carries nothing else: `DELETE /api/user/:id` and the self-leave branch of
 * `DELETE /api/family/:id/member/:uid`. An empty body ⇒ `""` (not supplied); else
 * the value `sanitizeVerifySecret()` returns, or the 400 to send — `INVALID_JSON`,
 * `INVALID_PAYLOAD` (not an object; arrays and `null` included) or
 * `INVALID_VERIFY_SECRET`. Reads no KV and charges nothing.
 */
export async function readCurrentSecretBody(
  c: Context<{ Bindings: Env }>,
): Promise<string | (Response & TypedResponse<ErrorBody, 400, "json">)> {
  const text = await c.req.text();
  if (text === "") return "";

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }
  if (!isJsonObject(body)) {
    return jsonError(
      c,
      400,
      "INVALID_PAYLOAD",
      "Request body must be an object",
    );
  }

  const currentSecret = sanitizeVerifySecret(body.currentSecret);
  if (currentSecret === null) {
    return verifySecretFormatResponse(c, "currentSecret");
  }
  return currentSecret;
}

/**
 * Bearer-currency check plus current-secret step-up for the authenticated caller's
 * own account, used by self-leave (`DELETE /api/family/:id/member/:uid` with
 * `uid` = caller) and `PUT /api/family/:id/transfer`. Reads `verify:{userId}` and
 * `auth:{userId}` once each, in parallel. Returns `null` to proceed, else the error
 * response to send:
 *
 * - `401 UNAUTHORIZED` when the presented token is not one of the account's current
 *   tokens or carries no bearer hash (`readPresentedAuth`) — for every account type.
 * - Otherwise {@link enforceCurrentSecret}'s outcome: the stale-record `403
 *   VERIFICATION_REQUIRED` for every record shape, then, for a configured PIN /
 *   pattern, the gate's `403` / `429` / `503`. `requiredMessage` replaces only the
 *   message of the gate's no-secret `VERIFICATION_REQUIRED`.
 *
 * `currentSecret` is `sanitizeVerifySecret()`'s value (`""` = not supplied). Callers
 * run this BEFORE reading `family:{id}`, so the record's read-modify-write window
 * stays as short as without a step-up.
 *
 * `DELETE /api/user/:id` (which also reads `member:{userId}` in the same parallel
 * batch) and `PUT /api/user/:id/verify` (which reuses the records it read afterwards)
 * deliberately keep their own inline reads instead of calling this helper.
 *
 * See docs/architecture.md → 只有帳號目前的 token 能改驗證設定.
 */
export async function enforceCallerCurrentSecret(
  c: Context<{ Bindings: Env }>,
  userId: string,
  currentSecret: string,
  requiredMessage?: string,
): Promise<
  (Response & TypedResponse<ErrorBody, 401 | 403 | 429 | 503, "json">) | null
> {
  const [verifyRecord, presented] = await Promise.all([
    getVerifyRecord(c.env.KV, userId),
    readPresentedAuth(c.env.KV, userId, getPresentedAuthToken(c)),
  ]);
  if (!presented.current || presented.presentedHash === null) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  return enforceCurrentSecret(
    c,
    userId,
    verifyRecord,
    currentSecret,
    presented.auth,
    presented.presentedHash,
    requiredMessage,
  );
}
