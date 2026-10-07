import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type { Env } from "../utils/env";
import {
  MAX_PUBLIC_SHELVES,
  type PublicShelf,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../kv/schema";
import {
  getPublicShelves,
  putPublicShelves,
  getPublicSnapshot,
  deletePublicSnapshot,
} from "../kv/publicShelves";
import { getUserBooksRecord } from "../kv/users";
import {
  sanitizePublicShelfTitle,
  isValidExpiresDays,
  sanitizeCoverUrl,
  sanitizeReadmooUrl,
  isJsonObject,
} from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError, type ErrorBody } from "../utils/errors";
import {
  UserIdParam,
  UserShelfParams,
  ShareTokenParam,
} from "../schemas/common";
import {
  writePublicSnapshot,
  resolvePublicShelves,
} from "../services/publicShelf";

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

/** The single call site of `putPublicShelves`: `publicshelves:{userId}` has one writer domain, the four
 *  handlers below. Rationale: .claude/rules/backend.md → KV Key Patterns (single-writer domain). */
async function writePublicShelves(
  kv: KVNamespace,
  userId: string,
  shelves: PublicShelf[],
): Promise<void> {
  const record: PublicShelvesRecord = { shelves };
  await putPublicShelves(kv, userId, record);
}

/** Shelf list for the list-only paths (public read, list, DELETE): pointer key, else `user:{userId}`.
 *  See docs/architecture.md → 公開書櫃的寫入與撤銷. */
async function readPublicShelves(
  kv: KVNamespace,
  userId: string,
): Promise<PublicShelf[]> {
  const pointer = await getPublicShelves(kv, userId);
  if (pointer) return resolvePublicShelves(pointer, null).shelves;
  const record = await getUserBooksRecord(kv, userId);
  return resolvePublicShelves(null, record).shelves;
}

interface ShelfLookup {
  record: UserBooksRecord;
  shelves: PublicShelf[];
  idx: number;
}

/** Locate a shelf for update / reset-token: pointer key + books record in parallel (a missing record
 *  is "not found"). DELETE never comes here — docs/architecture.md → 公開書櫃的寫入與撤銷. */
async function findShelf(
  kv: KVNamespace,
  userId: string,
  shelfId: string,
): Promise<ShelfLookup | null> {
  const [pointer, record] = await Promise.all([
    getPublicShelves(kv, userId),
    getUserBooksRecord(kv, userId),
  ]);
  if (!record) return null;
  const { shelves } = resolvePublicShelves(pointer, record);
  const idx = shelves.findIndex((s) => s.shelfId === shelfId);
  if (idx === -1) return null;
  return { record, shelves, idx };
}

/** Does a snapshot promise a LONGER lifetime than its shelf? `null` = permanent = +∞, so a permanent
 *  shelf is never outlived; against a time-limited one, a permanent or later snapshot is. */
function snapshotOutlivesShelf(
  snapshotExpiresAt: number | null,
  shelfExpiresAt: number | null,
): boolean {
  if (shelfExpiresAt === null) return false; // shelf permanent: nothing outlives it
  return snapshotExpiresAt === null || snapshotExpiresAt > shelfExpiresAt;
}

/** Live = the owner's shelf list still has `shelfId` with THIS token and the snapshot does not outlive it
 *  (monotonic). Read-only. Rationale: .claude/rules/backend.md → KV Key Patterns (read-side guard). */
async function isSnapshotLive(
  kv: KVNamespace,
  snapshot: PublicShelfSnapshot,
  shareToken: string,
): Promise<boolean> {
  const shelves = await readPublicShelves(kv, snapshot.userId);
  const shelf = shelves.find((s) => s.shelfId === snapshot.shelfId);
  if (!shelf) return false;
  return (
    shelf.shareToken === shareToken &&
    !snapshotOutlivesShelf(snapshot.expiresAt, shelf.expiresAt)
  );
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
    params: UserShelfParams,
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
    params: UserShelfParams,
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
    params: UserShelfParams,
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
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Pointer key first; the books record is read only for an un-migrated owner.
  const shelves = await readPublicShelves(c.env.KV, userId);
  return c.json({ data: { shelves } });
});

// POST /api/user/:id/public-shelf
publicShelfRoutes.openapi(createPublicShelfRoute, async (c) => {
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Shared "public-shelf" ceiling (30/hr across the four write handlers): bounds one account's burn
  // rate, not a hard bound. See docs/architecture.md → 每帳號寫入上限能擋住什麼.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }
  // A non-object JSON body (`null`, a primitive, an array) reads as `{}`, so it gets the
  // missing-title 400 below instead of throwing on `body.title` (500).
  const body: Record<string, unknown> = isJsonObject(parsed) ? parsed : {};

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

  // Pointer key + books record in parallel: the shelf list comes from the
  // resolver, the record is still what makes a snapshot possible at all.
  const [pointer, record] = await Promise.all([
    getPublicShelves(c.env.KV, userId),
    getUserBooksRecord(c.env.KV, userId),
  ]);
  if (!record) {
    return jsonError(
      c,
      400,
      "USER_NOT_FOUND",
      "User books must be synced before creating a public shelf",
    );
  }

  const { shelves } = resolvePublicShelves(pointer, record);
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

  // Writes the pointer key only (never `user:{userId}`); after a legacy fallback this write IS the
  // lazy migration. Rationale: .claude/rules/backend.md → KV Key Patterns.
  await writePublicShelves(c.env.KV, userId, [...shelves, shelf]);
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  return c.json({ data: { shelf } }, 201);
});

// PUT /api/user/:id/public-shelf/:shelfId
publicShelfRoutes.openapi(updatePublicShelfRoute, async (c) => {
  // Format already enforced by UserShelfParams (400 INVALID_USER_ID, then
  // INVALID_SHELF_ID).
  const { id: userId, shelfId } = c.req.valid("param");

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Shared "public-shelf" per-userId write ceiling (30/hr across all four write
  // handlers) — see the create handler for the KV-quota rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }
  // Non-object JSON body ⇒ `{}` ⇒ the no-fields INVALID_PAYLOAD 400 below (a
  // bare `null` used to throw here and answer 500) — same rule as create.
  const body: Record<string, unknown> = isJsonObject(parsed) ? parsed : {};

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
  await writePublicShelves(c.env.KV, userId, shelves);
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  return c.json({ data: { shelf } });
});

// POST /api/user/:id/public-shelf/:shelfId/reset-token
publicShelfRoutes.openapi(resetTokenRoute, async (c) => {
  // Format already enforced by UserShelfParams (400 INVALID_USER_ID, then
  // INVALID_SHELF_ID).
  const { id: userId, shelfId } = c.req.valid("param");

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

  // New snapshot → shelf list → old-snapshot delete (a failed delete leaves an orphan the guard
  // refuses). See docs/architecture.md → 公開書櫃的寫入與撤銷.
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  shelves[idx] = shelf;
  await writePublicShelves(c.env.KV, userId, shelves);

  await deletePublicSnapshot(c.env.KV, oldToken);

  return c.json({ data: { shelf } });
});

// DELETE /api/user/:id/public-shelf/:shelfId
publicShelfRoutes.openapi(deletePublicShelfRoute, async (c) => {
  // Format already enforced by UserShelfParams (400 INVALID_USER_ID, then
  // INVALID_SHELF_ID).
  const { id: userId, shelfId } = c.req.valid("param");

  const denied = authGuard(c, userId);
  if (denied) return denied;

  // Shared "public-shelf" per-userId write ceiling (30/hr across all four write
  // handlers) — see the create handler for the KV-quota rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...PUBLIC_SHELF_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // Shelf list ONLY, not `findShelf`: revocation must work without `user:{userId}` and costs no books
  // read. See docs/architecture.md → 公開書櫃的寫入與撤銷.
  const shelves = await readPublicShelves(c.env.KV, userId);
  const idx = shelves.findIndex((s) => s.shelfId === shelfId);
  if (idx === -1) {
    return jsonError(c, 404, "SHELF_NOT_FOUND", "Public shelf not found");
  }

  const token = shelves[idx].shareToken;

  // Pointer key FIRST (it IS the revocation), snapshot delete LAST: both partial failures fail closed.
  // An empty `shelves` array means migrated. See docs/architecture.md → 公開書櫃的寫入與撤銷.
  shelves.splice(idx, 1);
  await writePublicShelves(c.env.KV, userId, shelves);

  await deletePublicSnapshot(c.env.KV, token);

  return c.body(null, 204);
});

// ── Public query route (mounted at /api) ──────────────────────

export const publicQueryRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

// GET /api/public/:shareToken
publicQueryRoutes.openapi(getPublicSnapshotRoute, async (c) => {
  // Format already enforced by ShareTokenParam (400 INVALID_TOKEN).
  const { shareToken } = c.req.valid("param");

  const snapshot = await getPublicSnapshot(c.env.KV, shareToken);
  if (!snapshot) {
    return jsonError(
      c,
      404,
      "PUBLIC_SHELF_NOT_FOUND",
      "Public shelf not found or expired",
    );
  }

  // Guards in order: snapshot miss / KV TTL → expiresAt backstop → liveness; each answers like a miss.
  // Rationale: .claude/rules/backend.md → KV Key Patterns; cost: docs/architecture.md → 公開書櫃的寫入與撤銷.
  if (snapshot.expiresAt !== null && snapshot.expiresAt <= Date.now()) {
    return jsonError(
      c,
      404,
      "PUBLIC_SHELF_NOT_FOUND",
      "Public shelf not found or expired",
    );
  }

  // Side-effect-free: a dead orphan is never deleted here. A rotated token can 404 for ~60s on a colo
  // caching the old list. See docs/architecture.md → 公開書櫃的寫入與撤銷.
  const isLive = await isSnapshotLive(c.env.KV, snapshot, shareToken);
  if (!isLive) {
    return jsonError(
      c,
      404,
      "PUBLIC_SHELF_NOT_FOUND",
      "Public shelf not found or expired",
    );
  }

  return c.json({
    data: {
      title: snapshot.title,
      // Read-side twin of the scrub for pre-whitelist snapshots; response transform only, no KV write.
      // Rationale: .claude/rules/backend.md → KV Key Patterns (public-shelf paragraph).
      books: snapshot.books.map((b) => ({
        ...b,
        coverUrl: sanitizeCoverUrl(b.coverUrl),
        readmooUrl: sanitizeReadmooUrl(b.readmooUrl),
      })),
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    },
  });
});
