import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  MAX_PUBLIC_SHELVES,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
  type UserBooksRecord,
} from "../kv/schema";
import { isValidUserId, isValidRequestId, isValidShareToken, sanitizePublicShelfTitle, isValidExpiresDays } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { defaultHook, jsonRes } from "../utils/openapi";
import { UserIdParam, ShelfIdParam, ShareTokenParam } from "../schemas/common";

// ── Helpers ────────────────────────────────────────────────────

function generateShareToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sharedBooks(books: BookEntry[]): BookEntry[] {
  return books.filter((b) => b.isShared === BoolFlag.TRUE);
}

function remainingTtlSeconds(expiresAt: number | null): number | undefined {
  if (expiresAt === null) return undefined;
  const remaining = Math.floor((expiresAt - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

function buildSnapshot(
  userId: string,
  shelf: PublicShelf,
  books: BookEntry[],
): PublicShelfSnapshot {
  return {
    userId,
    shelfId: shelf.shelfId,
    title: shelf.title,
    books: sharedBooks(books),
    createdAt: shelf.createdAt,
    expiresAt: shelf.expiresAt,
  };
}

export async function writePublicSnapshot(
  kv: KVNamespace,
  userId: string,
  shelf: PublicShelf,
  books: BookEntry[],
): Promise<void> {
  const ttl = remainingTtlSeconds(shelf.expiresAt);
  if (ttl === 0) {
    await kv.delete(kvKeys.publicShelf(shelf.shareToken));
    return;
  }
  const snapshot = buildSnapshot(userId, shelf, books);
  const opts: KVNamespacePutOptions = {};
  if (ttl !== undefined) opts.expirationTtl = ttl;
  await kv.put(kvKeys.publicShelf(shelf.shareToken), JSON.stringify(snapshot), opts);
}

/** Shape of the 401/403 JSON body returned by {@link authGuard}. */
interface AuthError {
  error: { code: string; message: string };
}

function authGuard(
  c: Context<{ Bindings: Env }>,
  userId: string,
): (Response & TypedResponse<AuthError, 401 | 403, "json">) | null {
  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }
  if (authUserId !== userId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Cannot access another user's data" } },
      403,
    );
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

export const publicShelfRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// GET /api/user/:id/public-shelf
publicShelfRoutes.openapi(getPublicShelvesRoute, async (c) => {
  const userId = c.req.param("id");
  if (!isValidUserId(userId)) {
    return c.json({ error: { code: "INVALID_USER_ID", message: "userId format is invalid" } }, 400);
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  const record = await c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json");
  const shelves = record?.publicSharing?.shelves ?? [];
  return c.json({ data: { shelves } });
});

// POST /api/user/:id/public-shelf
publicShelfRoutes.openapi(createPublicShelfRoute, async (c) => {
  const userId = c.req.param("id");
  if (!isValidUserId(userId)) {
    return c.json({ error: { code: "INVALID_USER_ID", message: "userId format is invalid" } }, 400);
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } }, 400);
  }

  const title = sanitizePublicShelfTitle(body.title);
  if (title === null) {
    return c.json({ error: { code: "INVALID_TITLE", message: "Title must be 1–60 characters" } }, 400);
  }
  if (!isValidExpiresDays(body.expiresDays)) {
    return c.json({ error: { code: "INVALID_EXPIRES_DAYS", message: "expiresDays must be 7, 30, 60, 90, or null" } }, 400);
  }
  const expiresDays = body.expiresDays as number | null;

  const record = await c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json");
  if (!record) {
    return c.json({ error: { code: "USER_NOT_FOUND", message: "User books must be synced before creating a public shelf" } }, 400);
  }

  const shelves = record.publicSharing?.shelves ?? [];
  if (shelves.length >= MAX_PUBLIC_SHELVES) {
    return c.json({ error: { code: "MAX_SHELVES_REACHED", message: `Maximum ${MAX_PUBLIC_SHELVES} public shelf(s) allowed` } }, 409);
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
    return c.json({ error: { code: "INVALID_USER_ID", message: "userId format is invalid" } }, 400);
  }
  if (!isValidRequestId(shelfId)) {
    return c.json({ error: { code: "INVALID_SHELF_ID", message: "shelfId format is invalid" } }, 400);
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } }, 400);
  }

  const hasTitle = body.title !== undefined;
  const hasExpires = body.expiresDays !== undefined;
  if (!hasTitle && !hasExpires) {
    return c.json({ error: { code: "INVALID_PAYLOAD", message: "At least one of title or expiresDays is required" } }, 400);
  }

  let newTitle: string | undefined;
  if (hasTitle) {
    const sanitized = sanitizePublicShelfTitle(body.title);
    if (sanitized === null) {
      return c.json({ error: { code: "INVALID_TITLE", message: "Title must be 1–60 characters" } }, 400);
    }
    newTitle = sanitized;
  }

  if (hasExpires && !isValidExpiresDays(body.expiresDays)) {
    return c.json({ error: { code: "INVALID_EXPIRES_DAYS", message: "expiresDays must be 7, 30, 60, 90, or null" } }, 400);
  }
  const newExpiresDays = hasExpires ? (body.expiresDays as number | null) : undefined;

  const found = await findShelf(c.env.KV, userId, shelfId);
  if (!found) {
    return c.json({ error: { code: "SHELF_NOT_FOUND", message: "Public shelf not found" } }, 404);
  }

  const { record, shelves, idx } = found;
  const shelf = { ...shelves[idx] };
  if (newTitle !== undefined) shelf.title = newTitle;
  if (newExpiresDays !== undefined) {
    shelf.expiresDays = newExpiresDays;
    shelf.expiresAt = newExpiresDays ? Date.now() + newExpiresDays * 86_400_000 : null;
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
    return c.json({ error: { code: "INVALID_USER_ID", message: "userId format is invalid" } }, 400);
  }
  if (!isValidRequestId(shelfId)) {
    return c.json({ error: { code: "INVALID_SHELF_ID", message: "shelfId format is invalid" } }, 400);
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  const found = await findShelf(c.env.KV, userId, shelfId);
  if (!found) {
    return c.json({ error: { code: "SHELF_NOT_FOUND", message: "Public shelf not found" } }, 404);
  }

  const { record, shelves, idx } = found;
  const oldToken = shelves[idx].shareToken;
  const newToken = generateShareToken();
  const shelf = { ...shelves[idx], shareToken: newToken };

  // Write new snapshot first to avoid 404 window
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
    return c.json({ error: { code: "INVALID_USER_ID", message: "userId format is invalid" } }, 400);
  }
  if (!isValidRequestId(shelfId)) {
    return c.json({ error: { code: "INVALID_SHELF_ID", message: "shelfId format is invalid" } }, 400);
  }

  const denied = authGuard(c, userId);
  if (denied) return denied;

  const found = await findShelf(c.env.KV, userId, shelfId);
  if (!found) {
    return c.json({ error: { code: "SHELF_NOT_FOUND", message: "Public shelf not found" } }, 404);
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

export const publicQueryRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// GET /api/public/:shareToken
publicQueryRoutes.openapi(getPublicSnapshotRoute, async (c) => {
  const shareToken = c.req.param("shareToken");
  if (!isValidShareToken(shareToken)) {
    return c.json({ error: { code: "INVALID_TOKEN", message: "Invalid share token format" } }, 400);
  }

  const snapshot = await c.env.KV.get<PublicShelfSnapshot>(
    kvKeys.publicShelf(shareToken),
    "json",
  );
  if (!snapshot) {
    return c.json({ error: { code: "PUBLIC_SHELF_NOT_FOUND", message: "Public shelf not found or expired" } }, 404);
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
