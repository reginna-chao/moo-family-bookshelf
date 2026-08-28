import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  MAX_PUBLIC_SHELVES,
  type PublicShelf,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../kv/schema";
import {
  isValidUserId,
  isValidRequestId,
  isValidShareToken,
  sanitizePublicShelfTitle,
  isValidExpiresDays,
  sanitizeCoverUrl,
} from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError, type ErrorBody } from "../utils/errors";
import { UserIdParam, ShelfIdParam, ShareTokenParam } from "../schemas/common";
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

/**
 * Persist the public-shelf list to `publicshelves:{userId}`.
 *
 * Deliberately LOCAL to this module rather than exported from `services/`:
 * that key has exactly one writer domain — the four write handlers below — and
 * keeping the only `put` here makes that property checkable by reading one
 * file. The books / family-prefs paths must never call it, which is why it is
 * not on offer from a shared module.
 */
async function writePublicShelves(
  kv: KVNamespace,
  userId: string,
  shelves: PublicShelf[],
): Promise<void> {
  const record: PublicShelvesRecord = { shelves };
  await kv.put(kvKeys.publicShelves(userId), JSON.stringify(record));
}

/**
 * Read a user's shelf list the way the list-only paths want it: pointer key
 * first, and `user:{userId}` only when the pointer key is absent (un-migrated
 * owner). A migrated owner therefore pays one small KV read and never touches
 * the books record. Used by the public read path, the list handler, and the
 * DELETE handler — none of which needs `record.books`. The create / update /
 * reset-token handlers must rebuild a snapshot, so they read both in parallel
 * instead (see `findShelf`).
 */
async function readPublicShelves(
  kv: KVNamespace,
  userId: string,
): Promise<PublicShelf[]> {
  const pointer = await kv.get<PublicShelvesRecord>(
    kvKeys.publicShelves(userId),
    "json",
  );
  if (pointer) return resolvePublicShelves(pointer, null).shelves;
  const record = await kv.get<UserBooksRecord>(kvKeys.user(userId), "json");
  return resolvePublicShelves(null, record).shelves;
}

interface ShelfLookup {
  record: UserBooksRecord;
  shelves: PublicShelf[];
  idx: number;
}

/**
 * Locate a shelf for the update / reset-token handlers.
 *
 * Reads the pointer key and the books record in PARALLEL: the shelf list comes
 * from the resolver (pointer wins, legacy field is the migration fallback),
 * while `record.books` is still required to rebuild the snapshot — so a missing
 * books record remains "not found" for these handlers. DELETE deliberately does
 * NOT come through here: revocation never rebuilds a snapshot, so it must not
 * inherit the books-record precondition (see that handler).
 */
async function findShelf(
  kv: KVNamespace,
  userId: string,
  shelfId: string,
): Promise<ShelfLookup | null> {
  const [pointer, record] = await Promise.all([
    kv.get<PublicShelvesRecord>(kvKeys.publicShelves(userId), "json"),
    kv.get<UserBooksRecord>(kvKeys.user(userId), "json"),
  ]);
  if (!record) return null;
  const { shelves } = resolvePublicShelves(pointer, record);
  const idx = shelves.findIndex((s) => s.shelfId === shelfId);
  if (idx === -1) return null;
  return { record, shelves, idx };
}

/**
 * Does a snapshot promise a LONGER lifetime than the shelf backing it?
 *
 * `null` means permanent, i.e. +∞. A permanent shelf can never be outlived, so
 * it always answers `false`; against a time-limited shelf, a permanent
 * snapshot — or one carrying a later deadline — answers `true`.
 */
function snapshotOutlivesShelf(
  snapshotExpiresAt: number | null,
  shelfExpiresAt: number | null,
): boolean {
  if (shelfExpiresAt === null) return false; // shelf permanent: nothing outlives it
  return snapshotExpiresAt === null || snapshotExpiresAt > shelfExpiresAt;
}

/**
 * Is a stored snapshot still backed by its shelf?
 *
 * Live means the owner's shelf list still contains `shelfId`, that shelf still
 * carries THIS share token, and the snapshot does not outlive the shelf. A
 * deleted account, a deleted shelf or a rotated token (reset-token) therefore
 * reads as not-live — fail-closed, and self-healing on the owner's next save or
 * shelf operation, which rewrites the snapshot.
 *
 * The expiry half is MONOTONIC, not strict equality, and the asymmetry is the
 * point:
 * - Snapshot promises LONGER than the shelf (including a permanent snapshot of
 *   a now time-limited shelf) ⇒ dead. That is the direction in which an orphan
 *   or a rolled-back snapshot drifts, and the only one that could hand out more
 *   access than the shelf currently grants.
 * - Snapshot promises SHORTER ⇒ still readable, and simply dies at its own
 *   earlier deadline unless a later save refreshes it. A snapshot rewritten
 *   from a stale pointer read right after the owner EXTENDED the deadline looks
 *   exactly like this; strict equality used to 404 it even though the owner had
 *   just granted MORE access, not less.
 *
 * The authority is the POINTER key, falling back to the legacy record field
 * only for owners who have not migrated yet (`readPublicShelves`) — that
 * fallback is what keeps their existing public links working. The pointer key
 * is precisely what the books hot path cannot rewrite, so a snapshot that a
 * stale-read books sync resurrected after a revoke fails this check.
 * Read-only by design — see the call site.
 */
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

  // Pointer key first; the books record is read only for an un-migrated owner.
  const shelves = await readPublicShelves(c.env.KV, userId);
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

  // Pointer key + books record in parallel: the shelf list comes from the
  // resolver, the record is still what makes a snapshot possible at all.
  const [pointer, record] = await Promise.all([
    c.env.KV.get<PublicShelvesRecord>(kvKeys.publicShelves(userId), "json"),
    c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json"),
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

  // The pointer key is the only shelf-list write target — `user:{userId}` is
  // never touched here. When the resolver fell back to the legacy field, THIS
  // write is the lazy migration: the pointer key from now on outranks it.
  await writePublicShelves(c.env.KV, userId, [...shelves, shelf]);
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
  await writePublicShelves(c.env.KV, userId, shelves);
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

  // Snapshot before pointer key: a reader who fetches the shelf list after the
  // pointer write below always finds the new token's snapshot already in place,
  // so this order still closes the 404 window for them. It no longer closes it
  // fully for ANY shelf — the liveness guard revalidates every snapshot against
  // the pointer key, so that pointer write must ALSO have propagated to the
  // viewer's colo; until then the new token 404s for up to ~60s (fail-closed and
  // self-healing, see the read handler). Old-snapshot delete stays LAST so a
  // failure there leaves an orphan the guard already refuses to serve.
  await writePublicSnapshot(c.env.KV, userId, shelf, record.books);

  shelves[idx] = shelf;
  await writePublicShelves(c.env.KV, userId, shelves);

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

  // Shelf list ONLY — deliberately not `findShelf`. Revocation never reads
  // `record.books`, so requiring the books record would (a) make a shelf
  // unrevokable whenever `user:{userId}` is missing, e.g. a partially failed
  // account deletion that left the pointer key behind, and (b) cost a migrated
  // owner a books read they do not need.
  const shelves = await readPublicShelves(c.env.KV, userId);
  const idx = shelves.findIndex((s) => s.shelfId === shelfId);
  if (idx === -1) {
    return jsonError(c, 404, "SHELF_NOT_FOUND", "Public shelf not found");
  }

  const token = shelves[idx].shareToken;

  // Pointer key FIRST, snapshot delete LAST — same ordering rule as reset-token
  // and for the same reason: with the read-side liveness guard, the POINTER
  // write IS the revocation, so it must be the step that lands first. Both
  // partial failures are then fail-closed:
  //   - pointer write fails ⇒ nothing happened (shelf still listed AND its
  //     snapshot still there — consistent; the owner sees a 5xx and retries);
  //   - snapshot delete fails ⇒ an orphan the guard already refuses to serve.
  // Deleting first had a third, OPEN failure mode: snapshot gone but shelf still
  // listed, so the owner's next ordinary books sync rebuilt a snapshot for a
  // shelf that still carries the token — the revoked link came back READABLE,
  // indefinitely for a permanent shelf.
  //
  // An empty `shelves` array is a MIGRATED "no shelves" state and outranks any
  // legacy field left on `user:{userId}` — that is what stops a later books save
  // from re-listing the deleted shelf.
  shelves.splice(idx, 1);
  await writePublicShelves(c.env.KV, userId, shelves);

  await c.env.KV.delete(kvKeys.publicShelf(token));

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

  // Three layered guards, in this order — each one only narrows:
  //   1. KV TTL — primary expiry for a TIME-LIMITED snapshot.
  //   2. expiresAt backstop (below) — a time-limited snapshot that outlived its
  //      TTL or its shelf (e.g. reset-token's final delete failed).
  //   3. Liveness check (below) — runs for EVERY surviving snapshot, permanent
  //      or time-limited, and validates it against the owner's CURRENT shelf
  //      list: same shelfId, same shareToken, and an expiry that does not
  //      OUTLIVE the shelf's (monotonic, see `isSnapshotLive`). Covers
  //      reset-token / delete orphans, orphans left behind by account deletion
  //      (which only removes tokens the shelf list still knows about), a
  //      snapshot promising more lifetime than its shelf now grants, and — the
  //      reason it is no longer permanent-only — a snapshot RESURRECTED by a
  //      books save that ran on a stale cross-colo read of a revoked shelf.
  //
  // Why the pointer key is what makes guard 3 work: the authority is
  // `publicshelves:{userId}`, and the books / family-prefs hot paths never
  // write that key. A stale-read books sync can therefore re-publish snapshot
  // CONTENT, but it can never re-list the revoked shelf — so the resurrected
  // snapshot stays unreadable. Validating against `user:{userId}` alone could
  // not do this: that record is exactly what the racing save rolls back.
  //
  // Caveat on that guarantee, stated honestly: it holds once the pointer key is
  // VISIBLE to the READING colo. For ~60s after the FIRST migration write — the
  // revoke that creates the pointer key — a colo still holding a negative-cached
  // miss for it falls back to the legacy field, so a books save racing inside
  // that same window can leave the link briefly readable. Same order as KV's
  // inherent revocation-propagation delay, one-time per user (later revokes
  // overwrite an existing key), and self-healing.
  //
  // Cost, honestly: every public hit that holds a valid token now pays ONE
  // extra small KV read (`publicshelves:{userId}`) for a migrated owner, and
  // TWO for an un-migrated one — that pointer miss, plus a fallback read of the
  // FULL `user:{userId}` books record, which is not small. The second read
  // disappears on their first public-shelf write. A well-formed but unknown
  // token still stops at the snapshot miss above, costing one read.
  // The public per-IP tier (10/min) caps ONE source only — it does not bound
  // distributed load, which needs the edge (Cloudflare WAF).
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

  // Strictly side-effect-free: a dead orphan is NOT deleted here — the HANDLER
  // performs no KV writes, so a stranger can never choose a key to be written or
  // deleted (the request pipeline's per-IP rate counter is the only fixed write
  // per request). The orphan stays as unreadable dead data and is never
  // reclaimed (account deletion only clears tokens the shelf list still knows
  // about); its volume is bounded by how often cleanup writes fail — each
  // failure surfaces to the owner as a 5xx — not by MAX_PUBLIC_SHELVES, which
  // bounds LIVE shelves only.
  //
  // Known limitation, stated honestly: KV is eventually consistent and this is
  // the first read of the owner's shelf list on the public path, so every hit
  // warms it in the viewer's colo (default 60s read cache). After reset-token —
  // or delete-then-recreate — a colo holding the stale list will 404 the NEW
  // token for up to ~60s. That window now applies to time-limited shelves too,
  // which previously skipped this guard. Fail-closed and self-healing; accepted
  // as the cost of validating a snapshot against its owner's live shelf list.
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
      // Read-side twin of the aggregation scrub: a snapshot minted BEFORE the
      // whitelist existed keeps its foreign cover URL until the shelf is
      // refreshed — for a permanent shelf, indefinitely. Scrubbing on the way
      // out keeps the mitigation independent of whether the PWA CSP is
      // actually delivered (a self-hosted PWA on a host that ignores
      // `_headers` has none). Response transform only — no KV write.
      books: snapshot.books.map((b) => ({
        ...b,
        coverUrl: sanitizeCoverUrl(b.coverUrl),
      })),
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    },
  });
});
