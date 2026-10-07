import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import {
  BoolFlag,
  type FamilyMember,
  type FamilyRecord,
  type KickedRecord,
  normalizeFamilyRecord,
  hasMember,
  findMember,
  TOKEN_TTL_SECONDS,
} from "../kv/schema";
import {
  getFamilyRecord,
  putFamilyRecord,
  getMemberFamilyId,
  putMemberFamilyId,
  deleteMemberFamilyId,
  hasKickedTombstone,
  putKickedTombstone,
  deleteKickedTombstone,
} from "../kv/families";
import { getUserBooksRecord, putUserBooksRecord } from "../kv/users";
import { getQrTokenRecord, deleteQrToken } from "../kv/verify";
import {
  isValidUserId,
  isJsonObject,
  sanitizeDisplayName,
  sanitizeVerifySecret,
  validateDisplayName,
  sanitizeShortString,
  parseRecoveryFlag,
} from "../utils/validation";
import {
  generateAuthToken,
  getOrGenerateAuthToken,
  deleteAuthToken,
  getAuthenticatedUserId,
} from "../middleware/auth";
import { enforcePerUserRateLimit, getCallerIp } from "../middleware/rateLimit";
import {
  validateVerification,
  verificationErrorResponse,
  verifySecretFormatResponse,
} from "../services/verification";
import { settleDepartingBorrower } from "../services/borrowIndex";
import { dissolveFamily } from "../services/familyDissolve";
import { isActiveMember, isLiveMembership } from "../services/membership";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { FamilyIdParam, FamilyMemberParams } from "../schemas/common";

// Business logic is kept inline for simplicity; extract to services/ if handlers grow further

export const familyRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

/** Shared per-userId write ceiling for the six family-domain write handlers. */
export const FAMILY_WRITE_LIMIT = {
  scope: "family-write",
  max: 30,
  windowSec: 3600,
} as const;

function invalidDisplayNameResponse(c: Context<{ Bindings: Env }>) {
  return jsonError(
    c,
    400,
    "INVALID_DISPLAY_NAME",
    "displayName must be a string of 20 characters or fewer",
  );
}

/** The join handler's `403 MEMBER_REMOVED` — one builder so the tombstone gate and the post-write
 *  re-checks answer byte-identically. */
function memberRemovedResponse(c: Context<{ Bindings: Env }>) {
  return jsonError(
    c,
    403,
    "MEMBER_REMOVED",
    "你已被管理者移出此家庭，暫時無法重新加入",
  );
}

// --- Route definitions ---

const createFamilyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Family"],
  summary: "Create a new family",
  description:
    "Body: `{ userId: string, displayName?: string, verifySecret?: string }`. " +
    "`verifySecret` is required when the account has PWA login verification " +
    "(PIN / pattern / OTP) configured — the same gate as `POST /{id}/join`. " +
    "Accounts with no verification configured are unaffected. A `verifySecret` " +
    "that is present but malformed (not a string, or longer than 256 " +
    "characters) is rejected with 400 `INVALID_VERIFY_SECRET` by create, join " +
    "and `POST /api/auth/lookup` alike.",
  responses: {
    201: jsonRes("Family created successfully"),
    400: jsonRes("Invalid input"),
    403: jsonRes("Verification required or failed"),
    409: jsonRes("User already in a family"),
    429: jsonRes("Verification locked or attempt ceiling reached"),
  },
});

const joinFamilyRoute = createRoute({
  method: "post",
  path: "/{id}/join",
  tags: ["Family"],
  summary: "Join an existing family",
  description:
    "Body: `{ userId: string, displayName?: string, verifySecret?: string, " +
    "qrToken?: string, recovery?: 0 | 1 }`. `recovery` (BoolFlag) marks the " +
    "client's silent recovery join after a 401; absent means 0, any value " +
    "other than 0 / 1 is rejected with 400 `INVALID_RECOVERY_FLAG`. A " +
    "recovery join never admits a new member: `recovery: 1` from a user the " +
    "family does not list (they left, deleted their account, or were removed) " +
    "is refused with 409 `RECOVERY_NOT_MEMBER`, after the verification and " +
    "removed-member checks and before the capacity check. A listed member's " +
    "recovery reconnect is unaffected, and a manual join (`recovery` absent " +
    "or 0) is admitted exactly as before.",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("Joined family successfully"),
    400: jsonRes("Invalid input"),
    403: jsonRes("Verification failed, or member was removed by the owner"),
    404: jsonRes("Family not found"),
    409: jsonRes(
      "Already in a family, family full, or recovery join by a non-member",
    ),
    429: jsonRes("Rate limit exceeded"),
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/member/{uid}",
  tags: ["Family"],
  summary: "Remove a member from the family",
  description:
    "Owner-initiated removal of ANOTHER member (`uid` ≠ the authenticated " +
    "caller) writes a 6-hour kicked tombstone; while it lives, that user's " +
    "`POST /{id}/join` is refused with 403 `MEMBER_REMOVED`, including " +
    "reconnects and QR-token joins. A voluntary self-leave (`uid` = the " +
    "caller) writes no tombstone — leave-then-rejoin stays legitimate; only " +
    "the client's silent `recovery: 1` join is refused afterwards, because " +
    "the user is no longer listed (409 `RECOVERY_NOT_MEMBER`). The " +
    "tombstone is also written when the owner targets a userId that is not in " +
    "the family, so a retry after a partly-failed removal still applies the " +
    "ban even though the response is 404 `MEMBER_NOT_FOUND`. A removal made by " +
    "mistake does not have to be waited out: the owner can lift the ban at any " +
    "time with `DELETE /{id}/kicked/{uid}`.",
  request: {
    params: FamilyMemberParams,
  },
  responses: {
    200: jsonRes("Member removed"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family or member not found"),
    429: jsonRes("Rate limited"),
    500: jsonRes("Borrow cleanup failed"),
  },
});

const clearKickedRoute = createRoute({
  method: "delete",
  path: "/{id}/kicked/{uid}",
  tags: ["Family"],
  summary: "Clear a member's removal tombstone (un-kick)",
  description:
    "Owner-only remedy for a removal made by mistake: deletes " +
    "`kicked:{id}:{uid}`, so that userId can `POST /{id}/join` again straight " +
    "away instead of waiting out the 6-hour tombstone TTL. Idempotent — the " +
    "tombstone is deleted without being read, so a call for a userId that was " +
    "never removed (or whose tombstone already expired) also answers 200 " +
    "`{ cleared: 1 }`; the response never reveals whether a tombstone existed. " +
    "Lifting the ban does NOT re-add the member: they rejoin themselves with " +
    "the sync code, so security-ux Invariant 4 (removal is immediate and only " +
    "reversible by an explicit rejoin) still holds. Cross-family safety: the " +
    "key deleted is derived from the path `id`, and the caller must be the " +
    "owner OF THAT `id`, so no caller can clear a tombstone of another family.",
  request: {
    params: FamilyMemberParams,
  },
  responses: {
    200: jsonRes("Kicked tombstone cleared"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Not the owner"),
    404: jsonRes("Family not found"),
    429: jsonRes("Rate limited"),
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["Family"],
  summary: "List family members",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("Family members list"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    404: jsonRes("Family not found"),
  },
});

const updateDisplayNameRoute = createRoute({
  method: "put",
  path: "/{id}/member/{uid}/displayName",
  tags: ["Family"],
  summary: "Update member display name",
  request: {
    params: FamilyMemberParams,
  },
  responses: {
    200: jsonRes("Display name updated"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family or member not found"),
    429: jsonRes("Rate limited"),
  },
});

const updateMemberSettingsRoute = createRoute({
  method: "patch",
  path: "/{id}/member/{uid}",
  tags: ["Family"],
  summary: "Update member settings (canLend, readmooName)",
  request: {
    params: FamilyMemberParams,
  },
  responses: {
    200: jsonRes("Member settings updated"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family or member not found"),
    429: jsonRes("Rate limited"),
  },
});

const transferOwnershipRoute = createRoute({
  method: "put",
  path: "/{id}/transfer",
  tags: ["Family"],
  summary: "Transfer family ownership",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("Ownership transferred"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Not the owner"),
    404: jsonRes("Family not found"),
    429: jsonRes("Rate limited"),
  },
});

const updateEndpointRoute = createRoute({
  method: "put",
  path: "/{id}/endpoint",
  tags: ["Family"],
  summary: "Update family API endpoint",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("Endpoint updated"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Not the owner"),
    404: jsonRes("Family not found"),
    429: jsonRes("Rate limited"),
  },
});

// --- Handlers ---

// POST /api/family — create new family
familyRoutes.openapi(createFamilyRoute, async (c) => {
  const familyId = generateFamilyId();

  let body: {
    userId: string;
    displayName?: string;
    verifySecret?: unknown;
  } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body?.userId) {
    return jsonError(c, 400, "MISSING_USER_ID", "userId is required");
  }

  if (!isValidUserId(body.userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const displayName = sanitizeDisplayName(body.displayName);
  if (displayName === null) {
    return invalidDisplayNameResponse(c);
  }

  // Bound the secret before any lookup: "" = not supplied, null = malformed. Same in all three gate
  // entry points (see `sanitizeVerifySecret`).
  const sanitizedSecret = sanitizeVerifySecret(body.verifySecret);
  if (sanitizedSecret === null) {
    return verifySecretFormatResponse(c);
  }
  const verifySecret = sanitizedSecret === "" ? undefined : sanitizedSecret;

  // Prevent duplicate family creation — user must leave existing family first
  const membership = await classifyMembershipForCreate(c.env.KV, body.userId);
  if (membership === "in-family") {
    return jsonError(
      c,
      409,
      "ALREADY_IN_FAMILY",
      "已有家庭群組，無法再建立新的",
    );
  }

  // Verification gate: AFTER the ALREADY_IN_FAMILY 409, BEFORE any KV write or token mint (orphan
  // cleanup included). See docs/architecture.md → PWA 登入驗證機制 → 安全措施.
  const verification = await validateVerification(
    c.env,
    body.userId,
    verifySecret,
    { callerKey: getCallerIp(c) },
  );
  if (!verification.valid) {
    return verificationErrorResponse(c, verification.error);
  }

  if (membership === "orphaned") {
    await deleteMemberFamilyId(c.env.KV, body.userId);
  }

  const member: FamilyMember = {
    userId: body.userId,
    displayName,
    canLend: BoolFlag.TRUE,
  };

  const record = {
    familyId,
    ownerId: body.userId,
    members: [member],
    maxMembers: 2,
    createdAt: new Date().toISOString(),
  };

  // Sequential, pointer FIRST: a failure leaves only an orphan pointer the retry cleans up, never an
  // unreachable `family:{id}`. Rationale: .claude/rules/backend.md → Route handler invariants.
  await putMemberFamilyId(c.env.KV, body.userId, familyId);
  await putFamilyRecord(c.env.KV, familyId, record);

  const authToken = await generateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { ...record, authToken, expiresAt } }, 201);
});

// POST /api/family/:id/join
familyRoutes.openapi(joinFamilyRoute, async (c) => {
  // Format already enforced by FamilyIdParam (400 INVALID_FAMILY_ID).
  const { id: familyId } = c.req.valid("param");

  let body: {
    userId: string;
    displayName?: string;
    verifySecret?: unknown;
    qrToken?: string;
    recovery?: unknown;
  } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body?.userId) {
    return jsonError(c, 400, "MISSING_USER_ID", "userId is required");
  }

  if (!isValidUserId(body.userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const displayName = sanitizeDisplayName(body.displayName);
  if (displayName === null) {
    return invalidDisplayNameResponse(c);
  }

  // Bound the secret with the other format checks, before the gate: malformed = 400, never hashed or
  // charged. Same classification as create/lookup.
  const sanitizedSecret = sanitizeVerifySecret(body.verifySecret);
  if (sanitizedSecret === null) {
    return verifySecretFormatResponse(c);
  }
  const verifySecret = sanitizedSecret === "" ? undefined : sanitizedSecret;

  const recovery = parseRecoveryFlag(body.recovery);
  if (recovery === null) {
    return jsonError(
      c,
      400,
      "INVALID_RECOVERY_FLAG",
      "recovery must be 0 or 1",
    );
  }

  // Cheap, terminal pre-gate 409 for a LIVE membership elsewhere; a stale pointer is not deleted here (no
  // pre-gate writes). See docs/architecture.md → PWA 登入驗證機制 → 安全措施 (ALREADY_IN_FAMILY).
  const existingFamily = await getMemberFamilyId(c.env.KV, body.userId);
  if (
    existingFamily &&
    existingFamily !== familyId &&
    (await isLiveMembership(c.env.KV, existingFamily, body.userId))
  ) {
    return jsonError(
      c,
      409,
      "ALREADY_IN_FAMILY",
      "請先離開目前的家庭再加入新家庭",
    );
  }

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // A listed member is reconnecting: same verification gate as a new member, but the maxMembers
  // check applies to new members only (a full family never blocks a reconnect).
  const isExistingMember = hasMember(record.members, body.userId);

  // --- Verification gate (both existing-member reconnect and new-member join) ---
  const gateFailure = await passJoinVerificationGate(c, {
    userId: body.userId,
    qrToken: body.qrToken,
    verifySecret,
  });
  if (gateFailure) {
    return gateFailure;
  }

  // Kicked-tombstone gate, AFTER the verification gate, for both branches and QR-bypass joins alike.
  // See docs/architecture.md → PWA 登入驗證機制 → 安全措施 (MEMBER_REMOVED) and → 家庭成員的授權與移除.
  const kicked = await hasKickedTombstone(c.env.KV, familyId, body.userId);
  if (kicked) {
    return memberRemovedResponse(c);
  }

  // A silent recovery join never admits a NEW member (#263): an unlisted user left or was
  // removed, and only a manual join may bring them back. No KV op; precedes FAMILY_FULL.
  if (!isExistingMember && recovery === BoolFlag.TRUE) {
    return jsonError(c, 409, "RECOVERY_NOT_MEMBER", "你已經不是這個家庭的成員");
  }

  const step = { familyId, userId: body.userId, displayName, record };
  return isExistingMember
    ? reconnectExistingMember(c, { ...step, existingFamily })
    : admitNewMember(c, step);
});

// DELETE /api/family/:id/member/:uid
familyRoutes.openapi(removeMemberRoute, async (c) => {
  // Format already enforced by FamilyMemberParams (400 INVALID_FAMILY_ID, then
  // INVALID_USER_ID).
  const { id: familyId, uid: targetUserId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);

  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Shared "family-write" ceiling (30/hr, six handlers), charged to the AUTHENTICATED caller, never `:uid`.
  // Rationale: .claude/rules/backend.md → Route handler invariants; docs/architecture.md → 每帳號寫入上限能擋住什麼.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // OWNER_CANNOT_LEAVE is decided by `ownerId` + the list ALONE (no pointer read); an unlisted owner
  // takes the MEMBER_NOT_FOUND cleanup. Rationale: .claude/rules/backend.md → API Design (bidirectional).
  if (
    callerId === record.ownerId &&
    targetUserId === callerId &&
    record.members.length > 1 &&
    hasMember(record.members, callerId)
  ) {
    return jsonError(c, 403, "OWNER_CANNOT_LEAVE", "請先轉移管理權後再離開");
  }

  // Every other owner power needs `ownerId` AND an ACTIVE caller (#222); `&&` keeps the one pointer read
  // off non-owners. Rationale: .claude/rules/backend.md → API Design (bidirectional authorization).
  const callerIsOwner =
    callerId === record.ownerId &&
    (await isActiveMember(c.env.KV, familyId, callerId, record.members));

  // Active sole owner leaving (the multi-member case was refused above)
  if (callerIsOwner && targetUserId === callerId) {
    // Single-member owner: `dissolveFamily` (borrow index, family record) FIRST, then pointer + token —
    // a failure leaves only an orphan pointer. See .claude/rules/backend.md → Route handler invariants.
    await dissolveFamily(c.env.KV, familyId);
    await Promise.all([
      deleteMemberFamilyId(c.env.KV, callerId),
      deleteAuthToken(c.env.KV, callerId),
    ]);

    return c.json({ data: { ok: true } });
  }

  // Non-owner (hollow ex-owner included) cannot remove others
  if (!callerIsOwner && targetUserId !== callerId) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以移除其他成員");
  }

  // Finding #6: Check if target is actually a member
  if (!hasMember(record.members, targetUserId)) {
    // Idempotent re-kick (owner targeting another user), tombstone BEFORE the stray-pointer delete; can
    // pre-tombstone a never-member. See docs/architecture.md → 家庭成員的授權與移除.
    if (targetUserId !== callerId) {
      await writeKickedTombstone(c.env.KV, familyId, targetUserId, callerId);
    }

    // Stray-pointer cleanup for both callers (owner re-kick or retried self-leave): delete pointer + token
    // only when the pointer names THIS family. Rationale: .claude/rules/backend.md → API Design (removal).
    const strayPointer = await getMemberFamilyId(c.env.KV, targetUserId);
    if (strayPointer === familyId) {
      await Promise.all([
        deleteMemberFamilyId(c.env.KV, targetUserId),
        deleteAuthToken(c.env.KV, targetUserId),
      ]);
    }
    return jsonError(c, 404, "MEMBER_NOT_FOUND", "目標使用者不是家庭成員");
  }

  const remainingMembers = record.members.filter(
    (m) => m.userId !== targetUserId,
  );

  // A removal NEVER writes an empty member list — it dissolves (#222), deleting pointer + token only when
  // the pointer names THIS family. Rationale: .claude/rules/backend.md → API Design (removal bullet).
  if (remainingMembers.length === 0) {
    await dissolveFamily(c.env.KV, familyId);
    const leaverPointer = await getMemberFamilyId(c.env.KV, targetUserId);
    if (leaverPointer === familyId) {
      await Promise.all([
        deleteMemberFamilyId(c.env.KV, targetUserId),
        deleteAuthToken(c.env.KV, targetUserId),
      ]);
    }
    return c.json({ data: { ok: true } });
  }

  // Borrow settlement FIRST: if it throws (500), nothing has been written and the caller can retry.
  // See `settleDepartingBorrower` and .claude/rules/backend.md → KV Key Patterns (borrow index).
  try {
    await settleDepartingBorrower(c.env.KV, familyId, targetUserId);
  } catch (err) {
    console.error("BORROW_CLEANUP_FAILED", { familyId, targetUserId, err });
    return jsonError(
      c,
      500,
      "BORROW_CLEANUP_FAILED",
      "Failed to clean up borrow requests; member not removed",
    );
  }

  record.members = remainingMembers;

  // Owner kick only (never a self-leave): tombstone after the settlement, BEFORE the list put and revoke.
  // Rationale: .claude/rules/backend.md → API Design (kicked tombstone bullet).
  if (targetUserId !== callerId) {
    await writeKickedTombstone(c.env.KV, familyId, targetUserId, callerId);
  }

  // Member-list put FIRST, then the revoke: once the list lands the removal has taken effect (Inv-4).
  // Rationale: .claude/rules/backend.md → API Design; residuals: docs/architecture.md → 已接受的殘餘風險.
  await putFamilyRecord(c.env.KV, familyId, record);

  // Revoke only a pointer naming THIS family (another family's session is left alone); this read is
  // the removal's half of the tombstone/pointer pairing.
  const targetPointer = await getMemberFamilyId(c.env.KV, targetUserId);
  if (targetPointer === familyId) {
    await Promise.all([
      deleteMemberFamilyId(c.env.KV, targetUserId),
      deleteAuthToken(c.env.KV, targetUserId),
    ]);
  }

  return c.json({ data: record });
});

// DELETE /api/family/:id/kicked/:uid — owner lifts a removal ban (un-kick)
familyRoutes.openapi(clearKickedRoute, async (c) => {
  // Format already enforced by FamilyMemberParams (400 INVALID_FAMILY_ID, then
  // INVALID_USER_ID).
  const { id: familyId, uid: targetUserId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);

  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Shared "family-write" ceiling, charged to the AUTHENTICATED caller (never `:uid`) — see the DELETE
  // member handler.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Owner = `ownerId` AND an ACTIVE caller (#222), as in the DELETE member handler; one pointer read,
  // only for the recorded owner.
  if (
    callerId !== record.ownerId ||
    !(await isActiveMember(c.env.KV, familyId, callerId, record.members))
  ) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以解除移除限制");
  }

  // Idempotent, read-free delete scoped to the owned `:id`; lifts the ban only, never re-adds (Inv-4).
  // See docs/architecture.md → 家庭群組 API.
  await deleteKickedTombstone(c.env.KV, familyId, targetUserId);

  return c.json({ data: { cleared: BoolFlag.TRUE } });
});

// GET /api/family/:id/members
familyRoutes.openapi(listMembersRoute, async (c) => {
  // Format already enforced by FamilyIdParam (400 INVALID_FAMILY_ID).
  const { id: familyId } = c.req.valid("param");

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const memberFamily = await getMemberFamilyId(c.env.KV, userId);
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Same re-check as the bookshelf read (pointer alone is not proof); zero extra reads, same 404.
  if (!hasMember(record.members, userId)) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  // UNFILTERED on purpose: a hollow member (#222) stays visible so the owner can re-kick it.
  return c.json({ data: record });
});

// PUT /api/family/:id/member/:uid/displayName — update display name
familyRoutes.openapi(updateDisplayNameRoute, async (c) => {
  // Format already enforced by FamilyMemberParams (400 INVALID_FAMILY_ID, then
  // INVALID_USER_ID).
  const { id: familyId, uid: targetUserId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Only the user themselves can update their display name
  if (callerId !== targetUserId) {
    return jsonError(c, 403, "FORBIDDEN", "只能修改自己的顯示名稱");
  }

  // Shared "family-write" per-userId write ceiling (30/hr across the six family
  // write handlers) — see the DELETE member handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!isJsonObject(body) || !("displayName" in body)) {
    return jsonError(c, 400, "MISSING_DISPLAY_NAME", "displayName is required");
  }

  const displayName = validateDisplayName(body.displayName);
  if (displayName === null) {
    return invalidDisplayNameResponse(c);
  }

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Caller IS the target; ACTIVE, not merely listed (#222) — a hollow member must not write the record
  // back. Same 404 as an unlisted caller, one pointer read.
  const member = findMember(record.members, targetUserId);
  if (
    !member ||
    !(await isActiveMember(c.env.KV, familyId, callerId, record.members))
  ) {
    return jsonError(c, 404, "MEMBER_NOT_FOUND", "不是此家庭的成員");
  }

  member.displayName = displayName;

  await putFamilyRecord(c.env.KV, familyId, record);

  // Sync displayName to user record so it stays consistent across data stores
  const userRec = await getUserBooksRecord(c.env.KV, targetUserId);
  if (userRec) {
    userRec.displayName = displayName;
    userRec.lastUpdated = new Date().toISOString();
    await putUserBooksRecord(c.env.KV, targetUserId, userRec);
  }

  return c.json({ data: { userId: targetUserId, displayName } });
});

// PATCH /api/family/:id/member/:uid — update member settings (canLend, readmooName)
familyRoutes.openapi(updateMemberSettingsRoute, async (c) => {
  // Format already enforced by FamilyMemberParams (400 INVALID_FAMILY_ID, then
  // INVALID_USER_ID).
  const { id: familyId, uid: targetUserId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Shared "family-write" per-userId write ceiling (30/hr across the six family
  // write handlers) — see the DELETE member handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: { canLend?: unknown; readmooName?: unknown } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body || (body.canLend === undefined && body.readmooName === undefined)) {
    return jsonError(
      c,
      400,
      "MISSING_FIELDS",
      "At least one of canLend or readmooName is required",
    );
  }

  // Validate canLend if present
  if (body.canLend !== undefined) {
    if (body.canLend !== BoolFlag.FALSE && body.canLend !== BoolFlag.TRUE) {
      return jsonError(c, 400, "INVALID_FIELDS", "canLend must be 0 or 1");
    }
  }

  // readmooName: undefined = no change, null = clear, string = set (sanitizeShortString: non-empty,
  // ≤ 50 chars after cleaning); anything else (incl. "") → 400 INVALID_FIELDS.
  let readmooNameAction:
    { type: "set"; value: string } | { type: "delete" } | null = null;
  if (body.readmooName === null) {
    readmooNameAction = { type: "delete" };
  } else if (body.readmooName !== undefined) {
    const sanitized = sanitizeShortString(body.readmooName, 50);
    if (sanitized === null) {
      return jsonError(
        c,
        400,
        "INVALID_FIELDS",
        "readmooName must be a non-empty string of 50 characters or fewer, or null to clear",
      );
    }
    readmooNameAction = { type: "set", value: sanitized };
  }

  const raw = await getFamilyRecord(c.env.KV, familyId);
  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // The caller must be ACTIVE (#222; one pointer read); the TARGET need only be listed.
  // Rationale: .claude/rules/backend.md → API Design (bidirectional authorization).
  if (!(await isActiveMember(c.env.KV, familyId, callerId, record.members))) {
    return jsonError(
      c,
      403,
      "NOT_FAMILY_MEMBER",
      "You are not a member of this family",
    );
  }

  const member = findMember(record.members, targetUserId);
  if (!member) {
    return jsonError(
      c,
      404,
      "MEMBER_NOT_FOUND",
      "Target user is not a family member",
    );
  }

  // Caller proven ACTIVE above, so `callerId === record.ownerId` means an active owner (#222).
  // canLend: only the owner can change it.
  if (body.canLend !== undefined && callerId !== record.ownerId) {
    return jsonError(
      c,
      403,
      "FORBIDDEN",
      "Only the family owner can change canLend",
    );
  }

  // readmooName (set OR clear via null): owner OR the member themselves
  if (
    body.readmooName !== undefined &&
    callerId !== record.ownerId &&
    callerId !== targetUserId
  ) {
    return jsonError(
      c,
      403,
      "FORBIDDEN",
      "Only the family owner or the member themselves can change readmooName",
    );
  }

  // Apply updates
  if (body.canLend !== undefined) {
    member.canLend = body.canLend as BoolFlag;
  }
  if (readmooNameAction !== null) {
    if (readmooNameAction.type === "set") {
      member.readmooName = readmooNameAction.value;
    } else {
      delete member.readmooName;
    }
  }

  await putFamilyRecord(c.env.KV, familyId, record);

  return c.json({ data: member });
});

// PUT /api/family/:id/transfer — transfer ownership
familyRoutes.openapi(transferOwnershipRoute, async (c) => {
  // Format already enforced by FamilyIdParam (400 INVALID_FAMILY_ID).
  const { id: familyId } = c.req.valid("param");

  const callerUserId = getAuthenticatedUserId(c);
  if (!callerUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Shared "family-write" per-userId write ceiling (30/hr across the six family
  // write handlers) — see the DELETE member handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerUserId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  let body: {
    newOwnerId: string;
    userId?: string;
    clearEndpoint?: number;
  } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body?.newOwnerId) {
    return jsonError(c, 400, "MISSING_FIELDS", "newOwnerId is required");
  }

  if (!isValidUserId(body.newOwnerId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Owner = `ownerId` AND an ACTIVE caller (#222); a successful transfer costs two pointer reads
  // (caller here, `newOwnerId` below).
  if (
    callerUserId !== record.ownerId ||
    !(await isActiveMember(c.env.KV, familyId, callerUserId, record.members))
  ) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以轉移管理權");
  }

  // Use authenticated caller ID, not body.userId (which is kept for backwards compat)
  if (body.newOwnerId === callerUserId) {
    return jsonError(c, 400, "SAME_OWNER", "不能轉移給自己");
  }

  // The new owner must be ACTIVE (#222): a hollow member can no longer read the family. One read.
  if (
    !(await isActiveMember(c.env.KV, familyId, body.newOwnerId, record.members))
  ) {
    return jsonError(c, 400, "INVALID_MEMBER", "目標使用者不是家庭成員");
  }

  record.ownerId = body.newOwnerId;
  if (body.clearEndpoint === 1) {
    delete record.apiEndpoint;
  }
  await putFamilyRecord(c.env.KV, familyId, record);

  return c.json({ data: record });
});

/** Validate `apiEndpoint` for PUT /api/family/:id/endpoint; returns the value to persist (`null`
 *  clears it). Pure: the caller maps a failure onto a 400. */
function validateApiEndpoint(
  value: unknown,
):
  | { ok: true; normalized: string | null }
  | { ok: false; code: string; message: string } {
  if (typeof value === "string" && value.length > 2048) {
    return {
      ok: false,
      code: "INVALID_ENDPOINT",
      message: "API endpoint URL is too long",
    };
  }

  if (value === null) {
    return { ok: true, normalized: null };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      code: "INVALID_ENDPOINT",
      message: "apiEndpoint must be a string or null",
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      code: "INVALID_ENDPOINT",
      message: "apiEndpoint must be a valid URL",
    };
  }

  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    return {
      ok: false,
      code: "INVALID_ENDPOINT",
      message: "API endpoint must use HTTPS (or HTTP for localhost)",
    };
  }

  // Reject the cheap internal-address literals an owner could steer members at; deliberately not a
  // complete defence. See docs/architecture.md → 家庭 API 位址的驗證.
  const hostname = url.hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    // Every IPv6 literal (kept bracketed by WHATWG URL) is rejected, IPv4-mapped forms included.
    if (hostname.startsWith("[")) {
      return {
        ok: false,
        code: "INVALID_ENDPOINT",
        message: "IPv6 literal addresses are not allowed",
      };
    }

    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      const isPrivate =
        a === 10 || // 10.0.0.0/8
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) || // 192.168.0.0/16
        (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
        a === 127 || // 127.0.0.0/8 (loopback; exact 127.0.0.1 is carved out above)
        a === 0; // 0.0.0.0/8
      if (isPrivate) {
        return {
          ok: false,
          code: "INVALID_ENDPOINT",
          message: "Private or internal IP addresses are not allowed",
        };
      }
    }
  }

  // Normalize: remove trailing slashes
  return {
    ok: true,
    normalized: url.origin + url.pathname.replace(/\/+$/, ""),
  };
}

// PUT /api/family/:id/endpoint — update family API endpoint
familyRoutes.openapi(updateEndpointRoute, async (c) => {
  // Format already enforced by FamilyIdParam (400 INVALID_FAMILY_ID).
  const { id: familyId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Shared "family-write" per-userId write ceiling (30/hr across the six family
  // write handlers) — see the DELETE member handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const memberFamily = await getMemberFamilyId(c.env.KV, callerId);
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!isJsonObject(body) || !("apiEndpoint" in body)) {
    return jsonError(c, 400, "MISSING_FIELDS", "apiEndpoint is required");
  }

  const apiEndpoint: unknown = body.apiEndpoint;

  const result = validateApiEndpoint(apiEndpoint);
  if (!result.ok) {
    return jsonError(c, 400, result.code, result.message);
  }
  const normalizedEndpoint = result.normalized;

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // The pointer is half of ACTIVE (#222): the caller must also be listed. Zero extra reads, same 404 as
  // the pointer miss.
  if (!hasMember(record.members, callerId)) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  if (callerId !== record.ownerId) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以修改 API 端點");
  }

  if (normalizedEndpoint !== null) {
    record.apiEndpoint = normalizedEndpoint;
  } else {
    delete record.apiEndpoint;
  }

  await putFamilyRecord(c.env.KV, familyId, record);

  return c.json({ data: record });
});

/** Put the kick tombstone (one KV put, FAIL-OPEN: logs, never throws); callers pass only an owner kick
 *  of ANOTHER member. Rationale: .claude/rules/backend.md → API Design (kicked tombstone bullet). */
async function writeKickedTombstone(
  kv: KVNamespace,
  familyId: string,
  targetUserId: string,
  removedBy: string,
): Promise<void> {
  try {
    const kickedRecord: KickedRecord = {
      removedAt: new Date().toISOString(),
      removedBy,
    };
    await putKickedTombstone(kv, familyId, targetUserId, kickedRecord);
  } catch (err) {
    console.error("KICK_TOMBSTONE_WRITE_FAILED", {
      familyId,
      targetUserId,
      err,
    });
  }
}

/** Inputs shared by the join handler's two post-gate branches. */
interface JoinStepInput {
  familyId: string;
  userId: string;
  displayName: string;
  record: FamilyRecord;
}

/** Join's verification step: a one-time QR token issued to `userId` (one get + delete) skips the gate,
 *  else `validateVerification`. Returns the gate's error Response, or `null` when passed. */
async function passJoinVerificationGate(
  c: Context<{ Bindings: Env }>,
  input: {
    userId: string;
    qrToken: string | undefined;
    verifySecret: string | undefined;
  },
) {
  const { userId, qrToken, verifySecret } = input;

  // QR token bypass: if a valid one-time QR token is provided, skip verification.
  let skipVerification = false;
  if (qrToken && typeof qrToken === "string") {
    const qrRecord = await getQrTokenRecord(c.env.KV, qrToken);
    if (qrRecord && qrRecord.userId === userId) {
      skipVerification = true;
      // One-time use: delete immediately
      await deleteQrToken(c.env.KV, qrToken);
    }
    // If token invalid/expired/wrong-user, fall through to normal verification
  }

  // Verify PWA login verification (PIN / pattern / OTP) if user has it set.
  // Users with no verification record (method: "none") pass automatically.
  if (!skipVerification) {
    // Lockout charged to the CALLER (IP, IPv6 per /64), never the target; wrong guesses also hit the
    // charge-on-failure "verify" ceiling. See docs/architecture.md → PWA 登入驗證機制 → 安全措施.
    const verification = await validateVerification(
      c.env,
      userId,
      verifySecret,
      { callerKey: getCallerIp(c) },
    );
    if (!verification.valid) {
      return verificationErrorResponse(c, verification.error);
    }
  }

  return null;
}

/** Join's existing-member branch: heals the pointer (+ tombstone re-check, may 403) or, when not healing,
 *  may put a changed displayName; then `getOrGenerateAuthToken`. */
async function reconnectExistingMember(
  c: Context<{ Bindings: Env }>,
  input: JoinStepInput & { existingFamily: string | null },
) {
  const { familyId, userId, displayName, record, existingFamily } = input;

  // Heal a pointer not naming this family, then re-read the tombstone (mirrored kick pairing); a heal
  // never writes the record back. See docs/architecture.md → 家庭成員的授權與移除.
  const healsPointer = existingFamily !== familyId;
  if (healsPointer) {
    await putMemberFamilyId(c.env.KV, userId, familyId);
    if (await retractPointerIfKicked(c.env.KV, familyId, userId)) {
      return memberRemovedResponse(c);
    }
  }

  // Update displayName if changed — non-healing reconnects only (see above).
  const member = findMember(record.members, userId);
  if (
    !healsPointer &&
    member &&
    displayName !== "" &&
    member.displayName !== displayName
  ) {
    member.displayName = displayName;
    await putFamilyRecord(c.env.KV, familyId, record);
  }

  const authToken = await getOrGenerateAuthToken(c.env.KV, userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
  return c.json({ data: { ...record, authToken, expiresAt } }, 200);
}

/** Join's new-member branch: 409 FAMILY_FULL, else puts `family:{id}` then `member:{uid}`, re-checks the
 *  tombstone (may retract + 403) and mints a fresh token via `generateAuthToken`. */
async function admitNewMember(
  c: Context<{ Bindings: Env }>,
  input: JoinStepInput,
) {
  const { familyId, userId, displayName, record } = input;

  // --- New member flow: capacity check ---

  // NOTE: No atomic compare-and-swap in KV. Concurrent joins could bypass
  // maxMembers limit. Acceptable for 2-person families with low concurrency.
  if (record.members.length >= record.maxMembers) {
    return jsonError(c, 409, "FAMILY_FULL", "家庭成員已達上限");
  }
  record.members.push({
    userId,
    displayName,
    canLend: BoolFlag.TRUE,
  });

  // Sequential, family record FIRST: a failed pointer put is healed by the retry's reconnect branch.
  // See docs/architecture.md → 家庭成員的授權與移除.
  await putFamilyRecord(c.env.KV, familyId, record);
  await putMemberFamilyId(c.env.KV, userId, familyId);

  // Mirrored-order tombstone re-check, as in the heal; on retraction the list entry stays and no token
  // is minted. See docs/architecture.md → 家庭成員的授權與移除.
  if (await retractPointerIfKicked(c.env.KV, familyId, userId)) {
    return memberRemovedResponse(c);
  }

  const authToken = await generateAuthToken(c.env.KV, userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { ...record, authToken, expiresAt } }, 200);
}

/** Join half of the kick pairing: after the pointer put, re-read the tombstone; if present, delete the
 *  pointer only while it still names `familyId`; `true` → 403. .claude/rules/backend.md → API Design. */
async function retractPointerIfKicked(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<boolean> {
  if (!(await hasKickedTombstone(kv, familyId, userId))) {
    return false;
  }
  if ((await getMemberFamilyId(kv, userId)) === familyId) {
    await deleteMemberFamilyId(kv, userId);
  }
  return true;
}

/** Create-flow membership: "in-family" (live, `isLiveMembership`) / "orphaned" (stale pointer to delete) /
 *  "none". Read-only: cleanup runs after the gate (.claude/rules/backend.md → Route handler invariants). */
async function classifyMembershipForCreate(
  kv: KVNamespace,
  userId: string,
): Promise<"in-family" | "orphaned" | "none"> {
  const existingFamilyId = await getMemberFamilyId(kv, userId);
  if (!existingFamilyId) return "none";

  return (await isLiveMembership(kv, existingFamilyId, userId))
    ? "in-family"
    : "orphaned";
}

function generateFamilyId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const segments = [0, 4].map((start) => {
    let s = "";
    for (let i = start; i < start + 4; i++) {
      s += chars[bytes[i] % chars.length];
    }
    return s;
  });
  return segments.join("-");
}
