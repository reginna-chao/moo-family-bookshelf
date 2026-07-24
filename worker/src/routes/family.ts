import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  BorrowStatus,
  type BorrowRequest,
  type FamilyMember,
  type RawFamilyRecord,
  type QrTokenRecord,
  type UserBooksRecord,
  normalizeFamilyRecord,
  hasMember,
  findMember,
  TOKEN_TTL_SECONDS,
} from "../kv/schema";
import {
  isValidUserId,
  isValidFamilyId,
  sanitizeDisplayName,
  validateDisplayName,
  sanitizeShortString,
} from "../utils/validation";
import {
  generateAuthToken,
  getOrGenerateAuthToken,
  deleteAuthToken,
  getAuthenticatedUserId,
} from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { validateVerification } from "./verify";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";

// Business logic is kept inline for simplicity; extract to services/ if handlers grow further

export const familyRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

function invalidDisplayNameResponse(c: Context<{ Bindings: Env }>) {
  return jsonError(
    c,
    400,
    "INVALID_DISPLAY_NAME",
    "displayName must be a string of 20 characters or fewer",
  );
}

// --- Route definitions ---

const createFamilyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Family"],
  summary: "Create a new family",
  responses: {
    201: jsonRes("Family created successfully"),
    400: jsonRes("Invalid input"),
    409: jsonRes("User already in a family"),
  },
});

const joinFamilyRoute = createRoute({
  method: "post",
  path: "/{id}/join",
  tags: ["Family"],
  summary: "Join an existing family",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: jsonRes("Joined family successfully"),
    400: jsonRes("Invalid input"),
    403: jsonRes("Verification failed"),
    404: jsonRes("Family not found"),
    409: jsonRes("Already in a family or family full"),
    429: jsonRes("Rate limit exceeded"),
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/member/{uid}",
  tags: ["Family"],
  summary: "Remove a member from the family",
  request: {
    params: z.object({ id: z.string(), uid: z.string() }),
  },
  responses: {
    200: jsonRes("Member removed"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family or member not found"),
    500: jsonRes("Borrow cleanup failed"),
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["Family"],
  summary: "List family members",
  request: {
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string(), uid: z.string() }),
  },
  responses: {
    200: jsonRes("Display name updated"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family or member not found"),
  },
});

const updateMemberSettingsRoute = createRoute({
  method: "patch",
  path: "/{id}/member/{uid}",
  tags: ["Family"],
  summary: "Update member settings (canLend, readmooName)",
  request: {
    params: z.object({ id: z.string(), uid: z.string() }),
  },
  responses: {
    200: jsonRes("Member settings updated"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family or member not found"),
  },
});

const transferOwnershipRoute = createRoute({
  method: "put",
  path: "/{id}/transfer",
  tags: ["Family"],
  summary: "Transfer family ownership",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: jsonRes("Ownership transferred"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Not the owner"),
    404: jsonRes("Family not found"),
  },
});

const updateEndpointRoute = createRoute({
  method: "put",
  path: "/{id}/endpoint",
  tags: ["Family"],
  summary: "Update family API endpoint",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: jsonRes("Endpoint updated"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Not the owner"),
    404: jsonRes("Family not found"),
  },
});

// --- Handlers ---

// POST /api/family — create new family
familyRoutes.openapi(createFamilyRoute, async (c) => {
  const familyId = generateFamilyId();

  let body: { userId: string; displayName?: string } | null;
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

  // Prevent duplicate family creation — user must leave existing family first
  const existingFamilyId = await c.env.KV.get(kvKeys.member(body.userId));
  if (existingFamilyId) {
    const oldRaw = await c.env.KV.get<RawFamilyRecord>(
      kvKeys.family(existingFamilyId),
      "json",
    );
    if (oldRaw) {
      return jsonError(
        c,
        409,
        "ALREADY_IN_FAMILY",
        "已有家庭群組，無法再建立新的",
      );
    }
    // Orphaned member key (family record missing) — clean up and proceed
    await c.env.KV.delete(kvKeys.member(body.userId));
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

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.put(kvKeys.member(body.userId), familyId),
  ]);

  const authToken = await generateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { ...record, authToken, expiresAt } }, 201);
});

// POST /api/family/:id/join
familyRoutes.openapi(joinFamilyRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  let body: {
    userId: string;
    displayName?: string;
    verifySecret?: string;
    qrToken?: string;
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

  // Per-userId rate limit: max 10 join attempts per userId per hour across all IPs.
  // Complements the per-IP rate limit; prevents distributed-IP abuse targeting a single user.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: body.userId,
    scope: "join",
    max: 10,
    windowSec: 3600,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // Check if user already belongs to a different family (before verify to avoid leaking membership info)
  const existingFamily = await c.env.KV.get(kvKeys.member(body.userId));
  if (existingFamily && existingFamily !== familyId) {
    return jsonError(
      c,
      409,
      "ALREADY_IN_FAMILY",
      "請先離開目前的家庭再加入新家庭",
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Existing members are reconnecting from a new device, not joining for the first
  // time. They still MUST pass the same verification gate as new members: knowing an
  // email-derived userId + familyId alone must not mint that member's token. The
  // maxMembers capacity check, by contrast, applies only to new members (an existing
  // member must never be blocked from reconnecting by a full family).
  const isExistingMember = hasMember(record.members, body.userId);

  // --- Verification gate (both existing-member reconnect and new-member join) ---

  // QR token bypass: if a valid one-time QR token is provided, skip verification.
  let skipVerification = false;
  if (body.qrToken && typeof body.qrToken === "string") {
    const qrRecord = await c.env.KV.get<QrTokenRecord>(
      kvKeys.qrToken(body.qrToken),
      "json",
    );
    if (qrRecord && qrRecord.userId === body.userId) {
      skipVerification = true;
      // One-time use: delete immediately
      await c.env.KV.delete(kvKeys.qrToken(body.qrToken));
    }
    // If token invalid/expired/wrong-user, fall through to normal verification
  }

  // Verify PWA login verification (PIN / pattern / OTP) if user has it set.
  // Users with no verification record (method: "none") pass automatically.
  if (!skipVerification) {
    const verification = await validateVerification(
      c.env.KV,
      body.userId,
      body.verifySecret,
    );
    if (!verification.valid && verification.error) {
      return c.json(
        {
          error: {
            code: verification.error.code,
            message: verification.error.message,
          },
        },
        verification.error.status as 403 | 429,
      );
    }
  }

  if (isExistingMember) {
    // Update displayName if changed
    const member = findMember(record.members, body.userId);
    if (member && displayName !== "" && member.displayName !== displayName) {
      member.displayName = displayName;
      await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
    }

    const authToken = await getOrGenerateAuthToken(c.env.KV, body.userId);
    const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
    return c.json({ data: { ...record, authToken, expiresAt } });
  }

  // --- New member flow: capacity check ---

  // NOTE: No atomic compare-and-swap in KV. Concurrent joins could bypass
  // maxMembers limit. Acceptable for 2-person families with low concurrency.
  if (record.members.length >= record.maxMembers) {
    return jsonError(c, 409, "FAMILY_FULL", "家庭成員已達上限");
  }
  record.members.push({
    userId: body.userId,
    displayName,
    canLend: BoolFlag.TRUE,
  });

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.put(kvKeys.member(body.userId), familyId),
  ]);

  const authToken = await generateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { ...record, authToken, expiresAt } });
});

// DELETE /api/family/:id/member/:uid
familyRoutes.openapi(removeMemberRoute, async (c) => {
  const familyId = c.req.param("id");
  const targetUserId = c.req.param("uid");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  const callerId = getAuthenticatedUserId(c);

  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  if (!isValidUserId(targetUserId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Owner trying to leave: allow only when they are the sole member
  if (callerId === record.ownerId && targetUserId === callerId) {
    if (record.members.length > 1) {
      return jsonError(c, 403, "OWNER_CANNOT_LEAVE", "請先轉移管理權後再離開");
    }

    // Single-member owner: delete entire family
    await Promise.all([
      c.env.KV.delete(kvKeys.family(familyId)),
      c.env.KV.delete(kvKeys.member(callerId)),
      deleteAuthToken(c.env.KV, callerId),
    ]);

    return c.json({ data: { ok: true } });
  }

  // Non-owner cannot remove others
  if (callerId !== record.ownerId && targetUserId !== callerId) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以移除其他成員");
  }

  // Finding #6: Check if target is actually a member
  if (!hasMember(record.members, targetUserId)) {
    return jsonError(c, 404, "MEMBER_NOT_FOUND", "目標使用者不是家庭成員");
  }

  // Auto-cancel PENDING borrow requests involving the removed member FIRST,
  // before mutating the family record. If this throws, the family record is
  // untouched and the caller can retry safely without leaving partial state.
  try {
    await cancelPendingBorrowsForMember(c.env.KV, familyId, targetUserId);
  } catch (err) {
    console.error("BORROW_CLEANUP_FAILED", { familyId, targetUserId, err });
    return jsonError(
      c,
      500,
      "BORROW_CLEANUP_FAILED",
      "Failed to clean up borrow requests; member not removed",
    );
  }

  record.members = record.members.filter((m) => m.userId !== targetUserId);

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.delete(kvKeys.member(targetUserId)),
    deleteAuthToken(c.env.KV, targetUserId),
  ]);

  return c.json({ data: record });
});

// GET /api/family/:id/members
familyRoutes.openapi(listMembersRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const memberFamily = await c.env.KV.get(kvKeys.member(userId));
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  return c.json({ data: record });
});

// PUT /api/family/:id/member/:uid/displayName — update display name
familyRoutes.openapi(updateDisplayNameRoute, async (c) => {
  const familyId = c.req.param("id");
  const targetUserId = c.req.param("uid");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  if (!isValidUserId(targetUserId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Only the user themselves can update their display name
  if (callerId !== targetUserId) {
    return jsonError(c, 403, "FORBIDDEN", "只能修改自己的顯示名稱");
  }

  let body: { displayName?: unknown } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body || !("displayName" in body)) {
    return jsonError(c, 400, "MISSING_DISPLAY_NAME", "displayName is required");
  }

  const displayName = validateDisplayName(body.displayName);
  if (displayName === null) {
    return invalidDisplayNameResponse(c);
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  const member = findMember(record.members, targetUserId);
  if (!member) {
    return jsonError(c, 404, "MEMBER_NOT_FOUND", "不是此家庭的成員");
  }

  member.displayName = displayName;

  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  // Sync displayName to user record so it stays consistent across data stores
  const userKey = kvKeys.user(targetUserId);
  const userRec = await c.env.KV.get<UserBooksRecord>(userKey, "json");
  if (userRec) {
    userRec.displayName = displayName;
    userRec.lastUpdated = new Date().toISOString();
    await c.env.KV.put(userKey, JSON.stringify(userRec));
  }

  return c.json({ data: { userId: targetUserId, displayName } });
});

// PATCH /api/family/:id/member/:uid — update member settings (canLend, readmooName)
familyRoutes.openapi(updateMemberSettingsRoute, async (c) => {
  const familyId = c.req.param("id");
  const targetUserId = c.req.param("uid");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  if (!isValidUserId(targetUserId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

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

  // Validate readmooName if present. Three accepted shapes:
  //   undefined → no change
  //   null      → delete field (clear readmooName)
  //   string    → set value (must pass sanitizeShortString: non-empty, ≤ 50 chars after cleaning)
  // Anything else (empty string, numbers, booleans, objects, …) → 400 INVALID_FIELDS.
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

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );
  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Verify caller is a member
  if (!hasMember(record.members, callerId)) {
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

  // Permission checks
  // canLend: only owner can change
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

  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: member });
});

// PUT /api/family/:id/transfer — transfer ownership
familyRoutes.openapi(transferOwnershipRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  const callerUserId = getAuthenticatedUserId(c);
  if (!callerUserId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

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

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  if (callerUserId !== record.ownerId) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以轉移管理權");
  }

  // Use authenticated caller ID, not body.userId (which is kept for backwards compat)
  if (body.newOwnerId === callerUserId) {
    return jsonError(c, 400, "SAME_OWNER", "不能轉移給自己");
  }

  if (!hasMember(record.members, body.newOwnerId)) {
    return jsonError(c, 400, "INVALID_MEMBER", "目標使用者不是家庭成員");
  }

  record.ownerId = body.newOwnerId;
  if (body.clearEndpoint === 1) {
    delete record.apiEndpoint;
  }
  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: record });
});

// PUT /api/family/:id/endpoint — update family API endpoint
familyRoutes.openapi(updateEndpointRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const memberFamily = await c.env.KV.get(kvKeys.member(callerId));
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  let body: { apiEndpoint: string | null } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body || !("apiEndpoint" in body)) {
    return jsonError(c, 400, "MISSING_FIELDS", "apiEndpoint is required");
  }

  if (typeof body.apiEndpoint === "string" && body.apiEndpoint.length > 2048) {
    return jsonError(
      c,
      400,
      "INVALID_ENDPOINT",
      "API endpoint URL is too long",
    );
  }

  let normalizedEndpoint: string | null = null;

  if (body.apiEndpoint !== null) {
    if (typeof body.apiEndpoint !== "string") {
      return jsonError(
        c,
        400,
        "INVALID_ENDPOINT",
        "apiEndpoint must be a string or null",
      );
    }

    let url: URL;
    try {
      url = new URL(body.apiEndpoint);
    } catch {
      return jsonError(
        c,
        400,
        "INVALID_ENDPOINT",
        "apiEndpoint must be a valid URL",
      );
    }

    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLocalhost)
    ) {
      return jsonError(
        c,
        400,
        "INVALID_ENDPOINT",
        "API endpoint must use HTTPS (or HTTP for localhost)",
      );
    }

    // Block private/internal IPs (SSRF prevention)
    const hostname = url.hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipMatch) {
        const [, a, b] = ipMatch.map(Number);
        const isPrivate =
          a === 10 || // 10.0.0.0/8
          (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
          (a === 192 && b === 168) || // 192.168.0.0/16
          (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
          a === 0; // 0.0.0.0/8
        if (isPrivate) {
          return jsonError(
            c,
            400,
            "INVALID_ENDPOINT",
            "Private or internal IP addresses are not allowed",
          );
        }
      }
    }

    // Normalize: remove trailing slashes
    normalizedEndpoint = url.origin + url.pathname.replace(/\/+$/, "");
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  if (callerId !== record.ownerId) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以修改 API 端點");
  }

  if (normalizedEndpoint !== null) {
    record.apiEndpoint = normalizedEndpoint;
  } else {
    delete record.apiEndpoint;
  }

  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: record });
});

/**
 * Cancel all PENDING borrow requests involving a removed member.
 * LENT requests are left as-is (the book may still be borrowed).
 */
async function cancelPendingBorrowsForMember(
  kv: KVNamespace,
  familyId: string,
  targetUserId: string,
): Promise<void> {
  const indexKey = kvKeys.borrowsByFamily(familyId);
  const requestIds = await kv.get<string[]>(indexKey, "json");
  if (!requestIds || requestIds.length === 0) return;

  const requests = await Promise.all(
    requestIds.map((id) => kv.get<BorrowRequest>(kvKeys.borrow(id), "json")),
  );

  const now = new Date().toISOString();
  const writeOps: Promise<void>[] = [];

  for (const req of requests) {
    if (req === null) continue;
    if (req.status !== BorrowStatus.PENDING) continue;
    if (req.borrowerId !== targetUserId && req.ownerId !== targetUserId)
      continue;

    req.status = BorrowStatus.CANCELLED;
    req.updatedAt = now;
    writeOps.push(kv.put(kvKeys.borrow(req.requestId), JSON.stringify(req)));
  }

  if (writeOps.length > 0) {
    await Promise.all(writeOps);
  }
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
