import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  MAX_PUBLIC_SHELVES,
  type PublicShelf,
  type PublicShelfSnapshot,
  type UserBooksRecord,
} from "../kv/schema";
import {
  isValidUserId,
  isValidRequestId,
  isValidShareToken,
  sanitizePublicShelfTitle,
  isValidExpiresDays,
} from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError, type ErrorBody } from "../utils/errors";
import { UserIdParam, ShelfIdParam, ShareTokenParam } from "../schemas/common";
import { writePublicSnapshot } from "../services/publicShelf";

// ── Helpers ────────────────────────────────────────────────────

/** Shared per-userId write ceiling for the four public-shelf write handlers. */
export const PUBLIC_SHELF_WRITE_LIMIT = {
  scope: "public-shelf",
  max: 30,
  windowSec: 3600,
} as const;

function generateShareToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function authGuard(
  c: Context<{ Bindings: Env }>,
  userId: string,
): (Response & TypedResponse<ErrorBody, 401 | 403, "json">) | null {
  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot access another user's data");
  }
  return null;
}

interface ShelfLookup {
  record: UserBooksRecord;
  shelves: PublicShelf[];
  idx: number;
}

async function findShelf(
  kv: KVNamespace,
  userId: string,
  shelfId: string,
): Promise<ShelfLookup | null> {
  const record = await kv.get<UserBooksRecord>(kvKeys.user(userId), "json");
  if (!record) return null;
  const shelves = record.publicSharing?.shelves ?? [];
  const idx = shelves.findIndex((s) => s.shelfId === shelfId);
  if (idx === -1) return null;
  return { record, shelves, idx };
}

/**
 * Is a PERMANENT snapshot (`expiresAt === null`) still backed by its shelf?
 *
 * Live means the owner's user record still exists, still lists `shelfId`, and
 * that shelf still points at THIS share token AND is itself still permanent.
 * A missing record (account deleted), a missing shelf (shelf deleted), a
 * rotated token (reset-token) or a shelf since converted to time-limited
 * therefore all read as not-live.
 *
 * The last case is the drift the `expiresAt === null` half exists for: the
 * update handler rewrote the record to time-limited but its snapshot rewrite
 * failed, so the SAME token still holds the old permanent snapshot with no TTL.
 * It must die rather than outlive the setting it contradicts. When that rewrite
 * succeeded the stored snapshot carries a non-null `expiresAt`, guard 2 owns it
 * and this helper never runs. Read-only by design — see the call site.
 */
async function isPermanentSnapshotLive(
  kv: KVNamespace,
  snapshot: PublicShelfSnapshot,
  shareToken: string,
): Promise<boolean> {
  const found = await findShelf(kv, snapshot.userId, snapshot.shelfId);
  if (!found) return false;
  const shelf = found.shelves[found.idx];
  return shelf.shareToken === shareToken && shelf.expiresAt === null;
}

// ── Route definitions (authenticated) ────────────────────────

const getPublicShelvesRoute = createRoute({
  method: "get",
  path: "/{id}/public-shelf",
  tags: ["PublicShelf"],
  summary: "List user public shelves",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("List of public shelves"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

const createPublicShelfRoute = createRoute({
  method: "post",
  path: "/{id}/public-shelf",
  tags: ["PublicShelf"],
  summary: "Create a public shelf",
  request: {
    params: UserIdParam,
  },
  responses: {
    201: jsonRes("Public shelf created"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    409: jsonRes("Max shelves reached"),
    429: jsonRes("Rate limited"),
  },
});

const updatePublicShelfRoute = createRoute({
  method: "put",
  path: "/{id}/public-shelf/{shelfId}",
  tags: ["PublicShelf"],
  summary: "Update a public shelf",
  request: {
    params: ShelfIdParam,
  },
  responses: {
    200: jsonRes("Updated public shelf"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Shelf not found"),
    429: jsonRes("Rate limited"),
  },
});

const resetTokenRoute = createRoute({
  method: "post",
  path: "/{id}/public-shelf/{shelfId}/reset-token",
  tags: ["PublicShelf"],
  summary: "Reset public shelf share token",
  request: {
    params: ShelfIdParam,
  },
  responses: {
    200: jsonRes("Token reset successfully"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Shelf not found"),
    429: jsonRes("Rate limited"),
  },
});

const deletePublicShelfRoute = createRoute({
  method: "delete",
  path: "/{id}/public-shelf/{shelfId}",
  tags: ["PublicShelf"],
  summary: "Delete a public shelf",
  request: {
    params: ShelfIdParam,
  },
  responses: {
    204: { description: "Shelf deleted" },
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Shelf not found"),
    429: jsonRes("Rate limited"),
  },
});

// ── Route definitions (public query) ─────────────────────────

const getPublicSnapshotRoute = createRoute({
  method: "get",
  path: "/public/{shareToken}",
  tags: ["PublicShelf"],
  summary: "Get public shelf by share token",
  request: {
    params: ShareTokenParam,
  },
  responses: {
    200: jsonRes("Public shelf snapshot"),
    400: jsonRes("Invalid token"),
    404: jsonRes("Shelf not found or expired"),
  },
});

// ── Authenticated routes (mounted at /api/user) ───────────────

export const publicShelfRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

// GET /api/user/:id/public-shelf
publicShelfRoutes.openapi(getPublicShelvesRoute, async (c) => {
  const userId = c.req.param("id");
  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  const record = await c.env.KV.get<UserBooksRecord>(
    kvKeys.user(userId),
    "json",
  );
  const shelves = record?.publicSharing?.shelves ?? [];
  return c.json({ data: { shelves } });
});

// POST /api/user/:id/public-shelf
publicShelfRoutes.openapi(createPublicShelfRoute, async (c) => {
  const userId = c.req.param("id");
  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Per-userId write ceiling: 30 public-shelf writes per userId per hour, shared
  // by create / update / reset-token / delete under one "public-shelf" scope.
  // Layered on top of the per-IP limit. Honest scope: this BOUNDS THE BURN RATE
  // of a single account's AUTHENTICATED writes (~120 KV writes/hr incl. both
  // counters), it does not make the daily 1000-write free tier safe — 30/hr
  // sustained is still ~2,880 writes/day, and the per-IP middleware's own
  // counter write lands BEFORE auth, so unauthenticated spam that ignores 429s
  // still burns ~60 writes/min (free tier drained in ~17 minutes) outside this
  // ceiling's reach. It turns "one authenticated account drains the quota in ~6
  // minutes" into "~8 hours", and forces an attacker to onboard a new family
  // per 30 writes. A hard global bound needs the edge (Cloudflare WAF rate
  // limiting, see docs/architecture.md and worker/DEPLOY.md) — deliberately not
  // attempted here.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const title = sanitizePublicShelfTitle(body.title);
  if (title === null) {
    return jsonError(c, 400, "INVALID_TITLE", "Title must be 1–60 characters");
  }
  if (!isValidExpiresDays(body.expiresDays)) {
    return jsonError(
      c,
      400,
      "INVALID_EXPIRES_DAYS",
      "expiresDays must be 7, 30, 60, 90, or null",
    );
  }
  const expiresDays = body.expiresDays as number | null;

  const record = await c.env.KV.get<UserBooksRecord>(
    kvKeys.user(userId),
    "json",
  );
  if (!record) {
    return jsonError(
      c,
      400,
      "USER_NOT_FOUND",
      "User books must be synced before creating a public shelf",
    );
  }

  const shelves = record.publicSharing?.shelves ?? [];
  if (shelves.length >= MAX_PUBLIC_SHELVES) {
    return jsonError(
      c,
      409,
      "MAX_SHELVES_REACHED",
      `Maximum ${MAX_PUBLIC_SHELVES} public shelf(s) allowed`,
    );
  }

  const now = Date.now();
  const shelf: PublicShelf = {
    shelfId: crypto.randomUUID(),
    shareToken: generateShareToken(),
    title,
    expiresDays,
    createdAt: now,
    expiresAt: expiresDays ? now + expiresDays * 86_400_000 : null,
    selectionMode: "all-shared",
  };

  record.publicSharing = { shelves: [...shelves, shelf] };
  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  return c.json({ data: { shelf } }, 201);
});

// PUT /api/user/:id/public-shelf/:shelfId
publicShelfRoutes.openapi(updatePublicShelfRoute, async (c) => {
  const userId = c.req.param("id");
  const shelfId = c.req.param("shelfId");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }
  if (!isValidRequestId(shelfId)) {
    return jsonError(c, 400, "INVALID_SHELF_ID", "shelfId format is invalid");
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Shared "public-shelf" per-userId write ceiling (30/hr across all four write
  // handlers) — see the create handler for the KV-quota rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const hasTitle = body.title !== undefined;
  const hasExpires = body.expiresDays !== undefined;
  if (!hasTitle && !hasExpires) {
    return jsonError(
      c,
      400,
      "INVALID_PAYLOAD",
      "At least one of title or expiresDays is required",
    );
  }

  let newTitle: string | undefined;
  if (hasTitle) {
    const sanitized = sanitizePublicShelfTitle(body.title);
    if (sanitized === null) {
      return jsonError(
        c,
        400,
        "INVALID_TITLE",
        "Title must be 1–60 characters",
      );
    }
    newTitle = sanitized;
  }

  if (hasExpires && !isValidExpiresDays(body.expiresDays)) {
    return jsonError(
      c,
      400,
      "INVALID_EXPIRES_DAYS",
      "expiresDays must be 7, 30, 60, 90, or null",
    );
  }
  const newExpiresDays = hasExpires
    ? (body.expiresDays as number | null)
    : undefined;

  const found = await findShelf(c.env.KV, userId, shelfId);
  if (!found) {
    return jsonError(c, 404, "SHELF_NOT_FOUND", "Public shelf not found");
  }

  const { record, shelves, idx } = found;
  const shelf = { ...shelves[idx] };
  if (newTitle !== undefined) shelf.title = newTitle;
  if (newExpiresDays !== undefined) {
    shelf.expiresDays = newExpiresDays;
    shelf.expiresAt = newExpiresDays
      ? Date.now() + newExpiresDays * 86_400_000
      : null;
  }

  shelves[idx] = shelf;
  record.publicSharing = { shelves };
  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  return c.json({ data: { shelf } });
});

// POST /api/user/:id/public-shelf/:shelfId/reset-token
publicShelfRoutes.openapi(resetTokenRoute, async (c) => {
  const userId = c.req.param("id");
  const shelfId = c.req.param("shelfId");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }
  if (!isValidRequestId(shelfId)) {
    return jsonError(c, 400, "INVALID_SHELF_ID", "shelfId format is invalid");
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Shared "public-shelf" per-userId write ceiling (30/hr across all four write
  // handlers) — see the create handler for the KV-quota rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const found = await findShelf(c.env.KV, userId, shelfId);
  if (!found) {
    return jsonError(c, 404, "SHELF_NOT_FOUND", "Public shelf not found");
  }

  const { record, shelves, idx } = found;
  const oldToken = shelves[idx].shareToken;
  const newToken = generateShareToken();
  const shelf = { ...shelves[idx], shareToken: newToken };

  // Snapshot before record: a reader who fetches the shelf list after the record
  // update below always finds the new token's snapshot already in place, so this
  // order still closes the 404 window for them. It no longer closes it fully for
  // a PERMANENT shelf — the liveness guard revalidates the new token against the
  // owner's record, so that record write must ALSO have propagated to the
  // viewer's colo; until then the new token 404s for up to ~60s (fail-closed and
  // self-healing, see the read handler).
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  shelves[idx] = shelf;
  record.publicSharing = { shelves };
  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

  await c.env.KV.delete(kvKeys.publicShelf(oldToken));

  return c.json({ data: { shelf } });
});

// DELETE /api/user/:id/public-shelf/:shelfId
publicShelfRoutes.openapi(deletePublicShelfRoute, async (c) => {
  const userId = c.req.param("id");
  const shelfId = c.req.param("shelfId");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }
  if (!isValidRequestId(shelfId)) {
    return jsonError(c, 400, "INVALID_SHELF_ID", "shelfId format is invalid");
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Shared "public-shelf" per-userId write ceiling (30/hr across all four write
  // handlers) — see the create handler for the KV-quota rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const found = await findShelf(c.env.KV, userId, shelfId);
  if (!found) {
    return jsonError(c, 404, "SHELF_NOT_FOUND", "Public shelf not found");
  }

  const { record, shelves, idx } = found;
  const token = shelves[idx].shareToken;
  await c.env.KV.delete(kvKeys.publicShelf(token));

  shelves.splice(idx, 1);
  record.publicSharing = { shelves };
  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

  return c.body(null, 204);
});

// ── Public query route (mounted at /api) ──────────────────────

export const publicQueryRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

// GET /api/public/:shareToken
publicQueryRoutes.openapi(getPublicSnapshotRoute, async (c) => {
  const shareToken = c.req.param("shareToken");
  if (!isValidShareToken(shareToken)) {
    return jsonError(c, 400, "INVALID_TOKEN", "Invalid share token format");
  }

  const snapshot = await c.env.KV.get<PublicShelfSnapshot>(
    kvKeys.publicShelf(shareToken),
    "json",
  );
  if (!snapshot) {
    return jsonError(
      c,
      404,
      "PUBLIC_SHELF_NOT_FOUND",
      "Public shelf not found or expired",
    );
  }

  // Three layered guards, split by whether the shelf has a deadline:
  //   1. KV TTL — primary expiry for a TIME-LIMITED snapshot.
  //   2. expiresAt backstop (below) — a time-limited snapshot that outlived its
  //      TTL or its shelf (e.g. reset-token's final delete failed).
  //   3. Liveness check (below) — a PERMANENT snapshot (expiresAt === null) has
  //      neither TTL nor deadline, so it is instead validated against the owner's
  //      record. Covers reset-token / delete orphans, orphans left behind by
  //      account deletion (which only removes tokens still listed on the record),
  //      and a shelf since converted to time-limited whose stale permanent
  //      snapshot lingered under the same token.
  // Cost: permanent-shelf reads pay ONE extra KV read; time-limited reads pay
  // nothing new (they are already double-covered by 1+2 and must not pay it).
  // The public per-IP tier (10/min) caps ONE source only — it does not bound
  // distributed load, which needs the edge (Cloudflare WAF). And the extra read
  // is reachable only while holding a VALID permanent token: a well-formed but
  // unknown token stops at the miss above, still costing the first read.
  // Every branch answers exactly like the missing-snapshot branch above, so an
  // orphan is indistinguishable from a token that never existed.
  if (snapshot.expiresAt !== null && snapshot.expiresAt <= Date.now()) {
    return jsonError(
      c,
      404,
      "PUBLIC_SHELF_NOT_FOUND",
      "Public shelf not found or expired",
    );
  }

  if (snapshot.expiresAt === null) {
    // Strictly side-effect-free: a dead orphan is NOT deleted here — the HANDLER
    // performs no KV writes, so a stranger can never choose a key to be written or
    // deleted (the request pipeline's per-IP rate counter is the only fixed write
    // per request). The orphan stays as unreadable dead data and is never
    // reclaimed (account deletion only clears tokens still on the record); its
    // volume is bounded by how often cleanup writes fail — each failure surfaces
    // to the owner as a 5xx — not by MAX_PUBLIC_SHELVES, which bounds LIVE
    // shelves only.
    //
    // Known limitation, stated honestly: KV is eventually consistent and this is
    // the FIRST read of `user:{userId}` on the public path, so every permanent
    // read warms that record in the viewer's colo (default 60s read cache). After
    // reset-token — or delete-then-recreate — a colo holding the stale record
    // will 404 the NEW token for up to ~60s. Fail-closed and self-healing;
    // accepted as the cost of validating a permanent snapshot against its owner.
    const isLive = await isPermanentSnapshotLive(
      c.env.KV,
      snapshot,
      shareToken,
    );
    if (!isLive) {
      return jsonError(
        c,
        404,
        "PUBLIC_SHELF_NOT_FOUND",
        "Public shelf not found or expired",
      );
    }
  }

  return c.json({
    data: {
      title: snapshot.title,
      books: snapshot.books,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    },
  });
});
