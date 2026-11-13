/** `GET` / `PATCH /api/user/:id/settings` — the settings that follow the account across browsers and the
 *  PWA (#460). Own module because `routes/user.ts` is far past the Worker's 300-line target. */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { putAccountSettings, readAccountSettings } from "../kv/accountSettings";
import {
  mergeAccountSettings,
  parseAccountSettingsPatch,
} from "../services/accountSettings";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { UserIdParam } from "../schemas/common";

export const userSettingsRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/{id}/settings",
  tags: ["User"],
  summary: "Get the caller's account settings",
  description:
    "Return the caller's account settings as `settings`: `syncArchived` and " +
    "`storePageChipEnabled` (BoolFlag 0/1), `autoSyncInterval` " +
    "(daily/weekly/monthly/never), `floatingIconSize` " +
    "(small/medium/large/icon). A field never set is omitted; no record " +
    "returns `{}`. The handler never answers 404, so a 404 means the Worker " +
    "predates this route.",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Account settings"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

const patchSettingsRoute = createRoute({
  method: "patch",
  path: "/{id}/settings",
  tags: ["User"],
  summary: "Update the caller's account settings",
  description:
    "Body `{ settings?, ifAbsent? }`, both objects of the same four optional " +
    "fields as GET. Fields in `settings` overwrite; fields in `ifAbsent` are " +
    "written only where the server has no value yet (`settings` wins when " +
    "both name a field). Unknown keys are ignored; at least one known field " +
    "is required. One write at most, none when nothing changes. Returns the " +
    "merged record as `settings`. A 404 means the Worker predates this route.",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Merged account settings"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    429: jsonRes("Rate limited"),
  },
});

userSettingsRoutes.openapi(getSettingsRoute, async (c) => {
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot access another user's data");
  }

  // No record or a corrupt one reads as `{}`: clients take a 404 to mean "route missing".
  const settings = await readAccountSettings(c.env.KV, userId);
  return c.json({ data: { settings } });
});

userSettingsRoutes.openapi(patchSettingsRoute, async (c) => {
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
    scope: "account-settings",
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

  const patch = parseAccountSettingsPatch(body);
  if ("code" in patch) {
    return jsonError(c, 400, patch.code, patch.message);
  }

  // One write at most: KV takes one write per second per key — backend.md → KV Key Patterns.
  const stored = await readAccountSettings(c.env.KV, userId);
  const { next, changed } = mergeAccountSettings(
    stored,
    patch.settings,
    patch.ifAbsent,
  );
  if (changed) await putAccountSettings(c.env.KV, userId, next);

  return c.json({ data: { ok: true, settings: next } });
});
