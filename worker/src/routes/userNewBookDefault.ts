/** `PUT /api/user/:id/new-book-default` — the per-user "newly synced books default to shared" setting
 *  (#238). Own module because `routes/user.ts` is far past the Worker's 300-line target. */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { putNewBookDefault } from "../kv/newBookDefault";
import { isJsonObject, parseRequiredBoolFlag } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { UserIdParam } from "../schemas/common";

export const userNewBookDefaultRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

const putNewBookDefaultRoute = createRoute({
  method: "put",
  path: "/{id}/new-book-default",
  tags: ["User"],
  summary: "Save the caller's new-book default-sharing setting",
  description:
    "Set `newBookDefaultShared` (BoolFlag 0/1, required) for the caller. " +
    "When 1, the Extension marks books new to the server as shared at sync " +
    "time. Stored in its own key, so the books record (`lastUpdated` " +
    "included) is untouched, no public snapshot is written, and no books " +
    "record is required. `GET /api/user/{id}/books` returns the saved value " +
    "as `newBookDefaultShared`. A 404 means the Worker predates this route.",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Saved new-book default-sharing setting"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    429: jsonRes("Rate limited"),
  },
});

userNewBookDefaultRoutes.openapi(putNewBookDefaultRoute, async (c) => {
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot modify another user's data");
  }

  // Hourly write ceiling charged before parsing — backend.md → Route handler invariants.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: authUserId,
    scope: "new-book-default",
    max: 60,
    windowSec: 3600,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: unknown;
  try {
    body = await c.req.json();
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
  const newBookDefaultShared = parseRequiredBoolFlag(body.newBookDefaultShared);
  if (newBookDefaultShared === null) {
    return jsonError(
      c,
      400,
      "INVALID_NEW_BOOK_DEFAULT",
      "newBookDefaultShared must be 0 or 1",
    );
  }

  // Own key, never `user:{id}`: no books write can roll it back — backend.md → KV Key Patterns.
  await putNewBookDefault(c.env.KV, userId, newBookDefaultShared);

  return c.json({ data: { ok: true, newBookDefaultShared } });
});
