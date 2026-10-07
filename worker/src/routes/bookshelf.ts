import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { BoolFlag, hasMember, normalizeFamilyRecord } from "../kv/schema";
import { getFamilyRecord, getMemberFamilyId } from "../kv/families";
import { getUserBooksRecord } from "../kv/users";
import { sanitizeCoverUrl, sanitizeReadmooUrl } from "../utils/validation";
import { filterActiveMembers } from "../services/membership";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { FamilyIdParam } from "../schemas/common";

export const bookshelfRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

// --- Route definition ---

const getFamilyBookshelfRoute = createRoute({
  method: "get",
  path: "/family/{id}/bookshelf",
  tags: ["Bookshelf"],
  summary: "Get aggregated family bookshelf",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("Aggregated family bookshelf"),
    400: jsonRes("Invalid family ID"),
    401: jsonRes("Unauthorized"),
    404: jsonRes("Family not found"),
    429: jsonRes("Rate limit exceeded"),
  },
});

// --- Handler ---

// GET /api/family/:id/bookshelf
bookshelfRoutes.openapi(getFamilyBookshelfRoute, async (c) => {
  // Format already enforced by FamilyIdParam (400 INVALID_FAMILY_ID).
  const { id: familyId } = c.req.valid("param");

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Per-userId cap on top of the per-IP limit: the costliest route (fan-out of 2N - 1 reads: N books
  // + one pointer per member but the caller, after the caller pointer + record). Mirrors borrow-list.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    scope: "bookshelf",
    max: 30,
    windowSec: 60,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const memberFamily = await getMemberFamilyId(c.env.KV, userId);
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  // Get family members
  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const family = normalizeFamilyRecord(raw);

  // The pointer alone is not proof: re-check the record read above (zero extra reads), answering
  // byte-identically to the pointer-mismatch 404. Rationale: .claude/rules/backend.md → API Design.
  if (!hasMember(family.members, userId)) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  // Aggregate ACTIVE members only (#222, Inv-4). Pointer reads run in parallel with the book reads, so
  // a hollow member's book read is wasted; the caller's pointer is not re-read.
  const [activeMembers, records] = await Promise.all([
    filterActiveMembers(c.env.KV, familyId, family.members, userId),
    Promise.all(
      family.members.map((member) =>
        getUserBooksRecord(c.env.KV, member.userId),
      ),
    ),
  ]);
  const activeIds = new Set(activeMembers.map((member) => member.userId));

  const memberBooks = family.members
    .map((member, index) => ({ member, record: records[index] }))
    .filter(({ member }) => activeIds.has(member.userId))
    .map(({ member, record }) => {
      // Read-side twin of the buildSnapshot chokepoint (coverUrl + readmooUrl) for dormant records.
      // Rationale: .claude/rules/backend.md → KV Key Patterns (public-shelf paragraph).
      const sharedBooks = (record?.books ?? [])
        .filter((b) => b.isShared === BoolFlag.TRUE)
        .map((b) => ({
          ...b,
          coverUrl: sanitizeCoverUrl(b.coverUrl),
          readmooUrl: sanitizeReadmooUrl(b.readmooUrl),
        }));
      return {
        userId: member.userId,
        displayName: member.displayName,
        books: sharedBooks,
        lastUpdated: record?.lastUpdated ?? null,
      };
    });

  return c.json(
    {
      data: {
        familyId,
        members: memberBooks,
      },
    },
    200,
  );
});
