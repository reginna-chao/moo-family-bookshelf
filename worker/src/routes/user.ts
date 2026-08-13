import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  type RawFamilyRecord,
  normalizeFamilyRecord,
  type UserBooksRecord,
  type PublicShelf,
  type BookEntry,
  MAX_FAMILY_PREF_ENTRIES,
} from "../kv/schema";
import { writePublicSnapshot } from "../services/publicShelf";
import {
  isValidUserId,
  isJsonObject,
  sanitizeDisplayName,
  isValidFamilyPrefRef,
} from "../utils/validation";
import { getAuthenticatedUserId, deleteAuthToken } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { UserIdParam } from "../schemas/common";

async function updateAllPublicSnapshots(
  kv: KVNamespace,
  userId: string,
  shelves: PublicShelf[],
  books: BookEntry[],
): Promise<void> {
  if (shelves.length === 0) return;
  await Promise.all(
    shelves.map((shelf) => writePublicSnapshot(kv, userId, shelf, books)),
  );
}

/**
 * Resolve the authoritative displayName for a user when saving their book list.
 * - In a family: the family record is the source of truth (including empty,
 *   which represents a deliberate clear). Prevents stale client cache from
 *   overwriting the server value.
 * - Not in a family: sanitize the client-supplied value. Returns "" if invalid.
 */
async function resolveDisplayName(
  kv: KVNamespace,
  userId: string,
  memberFamilyId: string | null,
  clientValue: unknown,
): Promise<string> {
  if (memberFamilyId) {
    const familyRaw = await kv.get<RawFamilyRecord>(
      kvKeys.family(memberFamilyId),
      "json",
    );
    if (familyRaw) {
      const self = normalizeFamilyRecord(familyRaw).members.find(
        (m) => m.userId === userId,
      );
      if (self) return self.displayName;
    }
  }
  return sanitizeDisplayName(clientValue) ?? "";
}

// ---------------------------------------------------------------------------
// Pure validation helpers (extracted for testability — keep handler thin)
// ---------------------------------------------------------------------------

export type ParseChangesOk = { ok: true; changeMap: Map<string, BoolFlag> };
export type ParseChangesErr = {
  ok: false;
  code: "INVALID_PAYLOAD";
  message: string;
};
export type ParseChangesResult = ParseChangesOk | ParseChangesErr;

/**
 * Validate the `changes` array from a PATCH body and build a Map<bookId, isShared>
 * for efficient apply. Returns an error descriptor on any validation failure
 * (caller converts to the appropriate HTTP response).
 */
export function parsePatchChanges(
  body: Record<string, unknown>,
  maxChanges: number,
): ParseChangesResult {
  if (!Array.isArray(body.changes)) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "changes array is required",
    };
  }
  const changes = body.changes as unknown[];
  if (changes.length === 0) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "changes array must not be empty",
    };
  }
  if (changes.length > maxChanges) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: `changes array exceeds maximum of ${maxChanges}`,
    };
  }
  const changeMap = new Map<string, BoolFlag>();
  for (const entry of changes) {
    if (typeof entry !== "object" || entry === null) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "Each change must be an object with bookId and isShared",
      };
    }
    const { bookId, isShared } = entry as Record<string, unknown>;
    if (typeof bookId !== "string" || bookId.length === 0) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "bookId must be a non-empty string",
      };
    }
    if (isShared !== BoolFlag.FALSE && isShared !== BoolFlag.TRUE) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "isShared must be 0 or 1",
      };
    }
    changeMap.set(bookId, isShared as BoolFlag);
  }
  return { ok: true, changeMap };
}

export type ValidateDisplayNameResult =
  { ok: true } | { ok: false; code: "INVALID_PAYLOAD"; message: string };

/**
 * Validate the optional `displayName` field on a PATCH body.
 * Returns ok:true when the field is absent OR valid; an error descriptor otherwise.
 */
export function validatePatchDisplayName(
  body: Record<string, unknown>,
): ValidateDisplayNameResult {
  if (body.displayName === undefined) return { ok: true };
  if (typeof body.displayName === "string" && body.displayName === "") {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "displayName must not be empty string",
    };
  }
  if (sanitizeDisplayName(body.displayName) === null) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "displayName is invalid",
    };
  }
  return { ok: true };
}

/**
 * The pref "kinds" the family-prefs endpoint accepts. Both are copy-scoped
 * `"{ownerId}:{bookId}"` ref lists living in the same `familyShelfPrefs`
 * container. Adding a future kind is a one-line change here.
 */
export const FAMILY_PREF_KINDS = ["hidden", "favorites"] as const;
export type FamilyPrefKind = (typeof FAMILY_PREF_KINDS)[number];

export type ParsedFamilyPrefs = Partial<Record<FamilyPrefKind, string[]>>;
export type ParseFamilyPrefsOk = { ok: true; prefs: ParsedFamilyPrefs };
export type ParseFamilyPrefsErr = {
  ok: false;
  code: "INVALID_PAYLOAD";
  message: string;
};
export type ParseFamilyPrefsResult = ParseFamilyPrefsOk | ParseFamilyPrefsErr;

type ParseListResult =
  | { ok: true; values: string[] }
  | { ok: false; code: "INVALID_PAYLOAD"; message: string };

/**
 * Validate a single pref-kind list: each entry must be a string ref in the
 * form `"{ownerId}:{bookId}"`, deduped (first-seen order preserved), capped at
 * `max`. An empty array is valid and means "clear this list".
 */
function parsePrefList(
  kind: FamilyPrefKind,
  value: unknown[],
  max: number,
): ParseListResult {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isValidFamilyPrefRef(entry)) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `Each ${kind} entry must be a string in the form '{ownerId}:{bookId}'`,
      };
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    values.push(entry);
  }
  if (values.length > max) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: `${kind} array exceeds maximum of ${max} entries`,
    };
  }
  return { ok: true, values };
}

/**
 * Validate the family-prefs PUT body. Each kind in `FAMILY_PREF_KINDS` is
 * validated only when its key is present in the body; absent kinds are omitted
 * from the result (the handler preserves their existing KV value). At least one
 * kind must be present. Returns an error descriptor on failure (caller converts
 * to the appropriate HTTP response).
 */
export function parseFamilyPrefs(
  body: unknown,
  max: number,
): ParseFamilyPrefsResult {
  // Reject primitives AND arrays before any `kind in body` — see isJsonObject.
  if (!isJsonObject(body)) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "request body must be a JSON object",
    };
  }
  const prefs: ParsedFamilyPrefs = {};
  let anyPresent = false;
  for (const kind of FAMILY_PREF_KINDS) {
    if (!(kind in body)) continue;
    anyPresent = true;
    if (!Array.isArray(body[kind])) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `${kind} must be an array`,
      };
    }
    const result = parsePrefList(kind, body[kind] as unknown[], max);
    if (!result.ok) return result;
    prefs[kind] = result.values;
  }
  if (!anyPresent) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "at least one of hidden/favorites array is required",
    };
  }
  return { ok: true, prefs };
}

export type ParseBooksOk = { ok: true; books: BookEntry[] };
export type ParseBooksErr = {
  ok: false;
  code: "INVALID_PAYLOAD";
  message: string;
};
export type ParseBooksResult = ParseBooksOk | ParseBooksErr;

/** Coerce a raw isShared/isArchived value to a BoolFlag. Any truthy-1 maps to TRUE, everything else FALSE. */
function toBoolFlag(value: unknown): BoolFlag {
  return value === BoolFlag.TRUE ? BoolFlag.TRUE : BoolFlag.FALSE;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validate and normalize the `books` array from a PUT body. Rejects the whole
 * payload if any entry is not an object with a non-empty string `bookId`.
 * Every entry is rebuilt from an explicit field allowlist so unvalidated client
 * fields never reach KV; isShared/isArchived are normalized to BoolFlag.
 */
export function parseBooks(
  rawBooks: unknown[],
  maxBooks: number,
): ParseBooksResult {
  if (rawBooks.length > maxBooks) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: `books array exceeds maximum of ${maxBooks}`,
    };
  }
  const books: BookEntry[] = [];
  for (const entry of rawBooks) {
    if (typeof entry !== "object" || entry === null) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "Each book must be an object",
      };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.bookId !== "string" || e.bookId.length === 0) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "Each book requires a non-empty string bookId",
      };
    }
    const book: BookEntry = {
      bookId: e.bookId,
      title: asString(e.title),
      author: asString(e.author),
      isbn: asString(e.isbn),
      coverUrl: asString(e.coverUrl),
      readmooUrl: asString(e.readmooUrl),
      category: asString(e.category),
      isShared: toBoolFlag(e.isShared),
    };
    if (e.isArchived !== undefined) {
      book.isArchived = toBoolFlag(e.isArchived);
    }
    books.push(book);
  }
  return { ok: true, books };
}

/**
 * Max books accepted in a single PUT — matches the PATCH change cap.
 *
 * Reachability note: over the real HTTP path this count-cap's 400 branch is
 * effectively unreachable, because 10001 minimal book entries far exceed the
 * 256KB request-body guard (`MAX_BODY_SIZE` in `index.ts`) and get rejected
 * with 413 first. The count-cap therefore mainly protects direct `parseBooks`
 * pure-function callers, where no body-size guard applies.
 */
export const MAX_PUT_BOOKS = 10000;

export const userRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// GET /api/user/:id/books
const getUserBooksRoute = createRoute({
  method: "get",
  path: "/{id}/books",
  tags: ["User"],
  summary: "Get user books",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("User books record"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

userRoutes.openapi(getUserBooksRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot access another user's data");
  }

  const key = kvKeys.user(userId);
  const record = await c.env.KV.get<UserBooksRecord>(key, "json");

  if (!record) {
    return c.json({ data: null });
  }

  return c.json({ data: record });
});

// PUT /api/user/:id/books
const putUserBooksRoute = createRoute({
  method: "put",
  path: "/{id}/books",
  tags: ["User"],
  summary: "Save user books",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Saved user books record"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    429: jsonRes("Rate limited"),
  },
});

userRoutes.openapi(putUserBooksRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot modify another user's data");
  }

  // Per-userId write rate limit: max 30 saves per userId per hour. Layered on
  // top of the per-IP limit; slows compromised-account abuse of the daily 1000
  // KV write quota (bounds the burn rate; cannot fully prevent exhaustion).
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: authUserId,
    scope: "put-books",
    max: 30,
    windowSec: 3600,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: Record<string, unknown> | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body || !Array.isArray(body.books)) {
    return jsonError(c, 400, "INVALID_PAYLOAD", "books array is required");
  }

  // Validate + normalize each book entry from an explicit allowlist. The raw
  // client payload is never spread into KV.
  const parsedBooks = parseBooks(body.books as unknown[], MAX_PUT_BOOKS);
  if (!parsedBooks.ok) {
    return jsonError(c, 400, parsedBooks.code, parsedBooks.message);
  }

  // familyShelfPrefs, when sent via this endpoint (the Extension round-trips the
  // saved record on sync), MUST pass the same ref-format/dedupe/cap checks as the
  // dedicated /family-prefs endpoint. Absent → preserve existing KV value.
  // Validation boundary: an empty `familyShelfPrefs: {}` (both keys absent) makes
  // parseFamilyPrefs return 400 and fails the whole PUT — deliberate, since real
  // Extension/PWA clients always round-trip a full `{ hidden, favorites }` object.
  let parsedPrefs: { hidden: string[]; favorites: string[] } | undefined;
  if (body.familyShelfPrefs !== undefined) {
    const prefsResult = parseFamilyPrefs(
      body.familyShelfPrefs,
      MAX_FAMILY_PREF_ENTRIES,
    );
    if (!prefsResult.ok) {
      return jsonError(c, 400, prefsResult.code, prefsResult.message);
    }
    parsedPrefs = {
      hidden: prefsResult.prefs.hidden ?? [],
      favorites: prefsResult.prefs.favorites ?? [],
    };
  }

  // Read user record + family membership in parallel (independent reads).
  const [existing, memberFamilyId] = await Promise.all([
    c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json"),
    c.env.KV.get(kvKeys.member(userId)),
  ]);

  // Resolve displayName: family record is authoritative when the user is in a family
  // (even an empty value, which represents a deliberate clear). Only fall back to the
  // client-supplied value when there is no family membership / family record.
  const serverDisplayName = await resolveDisplayName(
    c.env.KV,
    userId,
    memberFamilyId,
    body.displayName,
  );

  // Build the persisted record from a fixed allowlist only. userId always comes
  // from the authenticated path param, never from body.userId.
  const record: UserBooksRecord = {
    schemaVersion:
      typeof body.schemaVersion === "number" ? body.schemaVersion : 1,
    userId,
    displayName: serverDisplayName,
    books: parsedBooks.books,
    lastUpdated: new Date().toISOString(),
    publicSharing: existing?.publicSharing,
    familyShelfPrefs: parsedPrefs ?? existing?.familyShelfPrefs,
  };

  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

  // Update public shelf snapshots for all active shelves
  const shelves = record.publicSharing?.shelves ?? [];
  await updateAllPublicSnapshots(c.env.KV, userId, shelves, record.books);

  return c.json({ data: record });
});

// ---------------------------------------------------------------------------
// PATCH /api/user/:id/books — partial update (only changed books)
// ---------------------------------------------------------------------------

const MAX_PATCH_CHANGES = 1000;

const patchUserBooksRoute = createRoute({
  method: "patch",
  path: "/{id}/books",
  tags: ["User"],
  summary: "Partially update user books (diff-only)",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Partial update applied"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("User record not found"),
    429: jsonRes("Rate limited"),
  },
});

userRoutes.openapi(patchUserBooksRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot modify another user's data");
  }

  // Per-userId write rate limit: shared scope with PUT (30 writes/hr total).
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: authUserId,
    scope: "put-books",
    max: 30,
    windowSec: 3600,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: Record<string, unknown> | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  // --- Validate changes array ---
  if (!body) {
    return jsonError(c, 400, "INVALID_PAYLOAD", "changes array is required");
  }
  const parsed = parsePatchChanges(body, MAX_PATCH_CHANGES);
  if (!parsed.ok) {
    return jsonError(c, 400, parsed.code, parsed.message);
  }
  const { changeMap } = parsed;

  // --- Validate optional displayName ---
  const nameCheck = validatePatchDisplayName(body);
  if (!nameCheck.ok) {
    return jsonError(c, 400, nameCheck.code, nameCheck.message);
  }

  // Read existing record + family membership in parallel
  const [existing, memberFamilyId] = await Promise.all([
    c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json"),
    c.env.KV.get(kvKeys.member(userId)),
  ]);

  if (!existing) {
    return jsonError(c, 404, "NOT_FOUND", "User record not found");
  }

  // Apply changes: update isShared for matching bookIds
  let applied = 0;
  const updatedBooks = existing.books.map((book) => {
    const newIsShared = changeMap.get(book.bookId);
    if (newIsShared !== undefined) {
      applied++;
      return { ...book, isShared: newIsShared };
    }
    return book;
  });

  // Short-circuit: no matching books and no displayName update → skip KV write
  // (avoids burning a KV write + snapshot writes on a pure no-op PATCH)
  if (applied === 0 && body.displayName === undefined) {
    return c.json({ data: { ok: true, applied: 0 } });
  }

  // Resolve displayName: only update if explicitly provided in body
  const displayName =
    body.displayName !== undefined
      ? await resolveDisplayName(
          c.env.KV,
          userId,
          memberFamilyId,
          body.displayName,
        )
      : existing.displayName;

  const record: UserBooksRecord = {
    ...existing,
    books: updatedBooks,
    displayName,
    lastUpdated: new Date().toISOString(),
  };

  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

  // Update public shelf snapshots for all active shelves
  const shelves = record.publicSharing?.shelves ?? [];
  await updateAllPublicSnapshots(c.env.KV, userId, shelves, record.books);

  return c.json({ data: { ok: true, applied } });
});

// ---------------------------------------------------------------------------
// PUT /api/user/:id/family-prefs — per-viewer private family-shelf prefs (v1.5.0)
// ---------------------------------------------------------------------------

const putFamilyPrefsRoute = createRoute({
  method: "put",
  path: "/{id}/family-prefs",
  tags: ["User"],
  summary: "Save per-viewer family-shelf preferences (hidden and/or favorites)",
  description:
    "Save the viewer's private family-shelf preferences. Accepts `hidden` " +
    "and/or `favorites` arrays of '{ownerId}:{bookId}' refs. A present field " +
    "full-replaces that list; an absent field preserves its existing value. " +
    "At least one of the two must be supplied. Returns the full merged container.",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Saved family-shelf preferences"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("User record not found"),
    429: jsonRes("Rate limited"),
  },
});

userRoutes.openapi(putFamilyPrefsRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }
  if (authUserId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "Cannot modify another user's data");
  }

  // Per-userId write rate limit: max 60 family-prefs saves per userId per hour.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: authUserId,
    scope: "family-prefs",
    max: 60,
    windowSec: 3600,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: Record<string, unknown> | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body) {
    return jsonError(
      c,
      400,
      "INVALID_PAYLOAD",
      "at least one of hidden/favorites array is required",
    );
  }
  const parsed = parseFamilyPrefs(body, MAX_FAMILY_PREF_ENTRIES);
  if (!parsed.ok) {
    return jsonError(c, 400, parsed.code, parsed.message);
  }

  const existing = await c.env.KV.get<UserBooksRecord>(
    kvKeys.user(userId),
    "json",
  );
  if (!existing) {
    return jsonError(c, 404, "NOT_FOUND", "User record not found");
  }

  // Per-field merge semantics: a field present in the body full-replaces that
  // list; an absent field preserves its existing KV value (protecting live
  // v1.5.0 clients that only send `hidden`). All other record fields — books,
  // displayName, publicSharing, schemaVersion, lastUpdated — are preserved
  // untouched, and no public snapshot is written (this is a private per-viewer
  // preference). Cross-device concurrent edits carry a lost-update risk,
  // acceptable for the single-user scenario.
  const existingPrefs = existing.familyShelfPrefs;
  const merged = {
    hidden: parsed.prefs.hidden ?? existingPrefs?.hidden ?? [],
    favorites: parsed.prefs.favorites ?? existingPrefs?.favorites ?? [],
  };

  const record: UserBooksRecord = {
    ...existing,
    familyShelfPrefs: merged,
  };

  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

  return c.json({
    data: { ok: true, hidden: merged.hidden, favorites: merged.favorites },
  });
});

// DELETE /api/user/:id — delete user account
const deleteUserRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["User"],
  summary: "Delete user account",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("User deleted"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

userRoutes.openapi(deleteUserRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);

  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  if (callerId !== userId) {
    return jsonError(
      c,
      403,
      "FORBIDDEN",
      "Cannot delete another user's account",
    );
  }

  // Check family membership
  const familyId = await c.env.KV.get(kvKeys.member(userId));

  if (familyId) {
    const raw = await c.env.KV.get<RawFamilyRecord>(
      kvKeys.family(familyId),
      "json",
    );

    if (raw) {
      const record = normalizeFamilyRecord(raw);

      if (record.ownerId === userId) {
        if (record.members.length > 1) {
          return jsonError(
            c,
            403,
            "OWNER_CANNOT_DELETE",
            "管理者必須先轉移管理權才能移除帳戶",
          );
        }

        // Single-member owner: delete entire family record
        await c.env.KV.delete(kvKeys.family(familyId));
      } else {
        // Remove user from family members
        record.members = record.members.filter((m) => m.userId !== userId);
        await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
      }
    }
  }

  // Collect public shelf tokens for cleanup
  const userRecord = await c.env.KV.get<UserBooksRecord>(
    kvKeys.user(userId),
    "json",
  );
  const publicTokens =
    userRecord?.publicSharing?.shelves?.map((s) => s.shareToken) ?? [];

  // Delete all user data in parallel
  await Promise.all([
    c.env.KV.delete(kvKeys.user(userId)),
    c.env.KV.delete(kvKeys.member(userId)),
    deleteAuthToken(c.env.KV, userId),
    ...publicTokens.map((token) => c.env.KV.delete(kvKeys.publicShelf(token))),
  ]);

  return c.json({ data: { ok: true } });
});
