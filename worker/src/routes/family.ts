import { Hono, type Context } from "hono";
import type { Env } from "../utils/env";
import { kvKeys, type FamilyMember, type FamilyRecord, type RawFamilyRecord, type QrTokenRecord, normalizeFamilyRecord, hasMember, findMember, TOKEN_TTL_SECONDS } from "../kv/schema";
import { isValidUserId, isValidFamilyId, sanitizeDisplayName, validateDisplayName } from "../utils/validation";
import { generateAuthToken, getOrGenerateAuthToken, deleteAuthToken, getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { validateVerification } from "./verify";

// Business logic is kept inline for simplicity; extract to services/ if handlers grow further

export const familyRoutes = new Hono<{ Bindings: Env }>();

function invalidDisplayNameResponse(c: Context<{ Bindings: Env }>) {
  return c.json(
    { error: { code: "INVALID_DISPLAY_NAME", message: "displayName must be a string of 20 characters or fewer" } },
    400,
  );
}

function toPublicRecord(record: FamilyRecord): FamilyRecord {
  return record;
}

// POST /api/family — create new family
familyRoutes.post("/", async (c) => {
  const familyId = generateFamilyId();

  let body: { userId: string; displayName?: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.userId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId is required" } },
      400,
    );
  }

  if (!isValidUserId(body.userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const displayName = sanitizeDisplayName(body.displayName);
  if (displayName === null) {
    return invalidDisplayNameResponse(c);
  }

  // Prevent duplicate family creation — user must leave existing family first
  const existingFamilyId = await c.env.KV.get(kvKeys.member(body.userId));
  if (existingFamilyId) {
    const oldRaw = await c.env.KV.get<RawFamilyRecord>(kvKeys.family(existingFamilyId), "json");
    if (oldRaw) {
      return c.json(
        { error: { code: "ALREADY_IN_FAMILY", message: "已有家庭群組，無法再建立新的" } },
        409,
      );
    }
    // Orphaned member key (family record missing) — clean up and proceed
    await c.env.KV.delete(kvKeys.member(body.userId));
  }

  const member: FamilyMember = { userId: body.userId, displayName };

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

  return c.json({ data: { ...toPublicRecord(record), authToken, expiresAt } }, 201);
});

// POST /api/family/:id/join
familyRoutes.post("/:id/join", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
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
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.userId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId is required" } },
      400,
    );
  }

  if (!isValidUserId(body.userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
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
    return c.json(
      { error: { code: "ALREADY_IN_FAMILY", message: "請先離開目前的家庭再加入新家庭" } },
      409,
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  // Existing members are reconnecting from a new device, not joining for the first time.
  // They were already verified when they originally joined. The Extension authenticates
  // via the user's Readmoo login (scraping email → deriving userId), which is sufficient
  // proof of identity. Skip verification and maxMembers check for them.
  const isExistingMember = hasMember(record.members, body.userId);

  if (isExistingMember) {
    // Update displayName if changed
    const member = findMember(record.members, body.userId);
    if (member && displayName !== "" && member.displayName !== displayName) {
      member.displayName = displayName;
      await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
    }

    const authToken = await getOrGenerateAuthToken(c.env.KV, body.userId);
    const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
    return c.json({ data: { ...toPublicRecord(record), authToken, expiresAt } });
  }

  // --- New member flow: verification + capacity check ---

  // QR token bypass: if a valid one-time QR token is provided, skip verification.
  let skipVerification = false;
  if (body.qrToken && typeof body.qrToken === "string") {
    const qrRecord = await c.env.KV.get<QrTokenRecord>(kvKeys.qrToken(body.qrToken), "json");
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
    const verification = await validateVerification(c.env.KV, body.userId, body.verifySecret);
    if (!verification.valid && verification.error) {
      return c.json(
        { error: { code: verification.error.code, message: verification.error.message } },
        verification.error.status as 403 | 429,
      );
    }
  }

  // NOTE: No atomic compare-and-swap in KV. Concurrent joins could bypass
  // maxMembers limit. Acceptable for 2-person families with low concurrency.
  if (record.members.length >= record.maxMembers) {
    return c.json(
      { error: { code: "FAMILY_FULL", message: "家庭成員已達上限" } },
      409,
    );
  }
  record.members.push({ userId: body.userId, displayName });

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.put(kvKeys.member(body.userId), familyId),
  ]);

  const authToken = await generateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { ...toPublicRecord(record), authToken, expiresAt } });
});

// DELETE /api/family/:id/member/:uid
familyRoutes.delete("/:id/member/:uid", async (c) => {
  const familyId = c.req.param("id");
  const targetUserId = c.req.param("uid");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);

  if (!callerId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  if (!isValidUserId(targetUserId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  // Owner trying to leave: allow only when they are the sole member
  if (callerId === record.ownerId && targetUserId === callerId) {
    if (record.members.length > 1) {
      return c.json(
        { error: { code: "OWNER_CANNOT_LEAVE", message: "請先轉移管理權後再離開" } },
        403,
      );
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
    return c.json(
      { error: { code: "NOT_OWNER", message: "只有管理者可以移除其他成員" } },
      403,
    );
  }

  // Finding #6: Check if target is actually a member
  if (!hasMember(record.members, targetUserId)) {
    return c.json(
      { error: { code: "MEMBER_NOT_FOUND", message: "目標使用者不是家庭成員" } },
      404,
    );
  }

  record.members = record.members.filter((m) => m.userId !== targetUserId);

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.delete(kvKeys.member(targetUserId)),
    deleteAuthToken(c.env.KV, targetUserId),
  ]);

  return c.json({ data: toPublicRecord(record) });
});

// GET /api/family/:id/members
familyRoutes.get("/:id/members", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  const memberFamily = await c.env.KV.get(kvKeys.member(userId));
  if (memberFamily !== familyId) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  return c.json({ data: toPublicRecord(record) });
});

// PUT /api/family/:id/member/:uid/displayName — update display name
familyRoutes.put("/:id/member/:uid/displayName", async (c) => {
  const familyId = c.req.param("id");
  const targetUserId = c.req.param("uid");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  if (!isValidUserId(targetUserId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  // Only the user themselves can update their display name
  if (callerId !== targetUserId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "只能修改自己的顯示名稱" } },
      403,
    );
  }

  let body: { displayName?: unknown } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body || !("displayName" in body)) {
    return c.json(
      { error: { code: "MISSING_DISPLAY_NAME", message: "displayName is required" } },
      400,
    );
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
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  const member = findMember(record.members, targetUserId);
  if (!member) {
    return c.json(
      { error: { code: "MEMBER_NOT_FOUND", message: "不是此家庭的成員" } },
      404,
    );
  }

  member.displayName = displayName;

  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: { userId: targetUserId, displayName } });
});

// PUT /api/family/:id/transfer — transfer ownership
familyRoutes.put("/:id/transfer", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  const callerUserId = getAuthenticatedUserId(c);
  if (!callerUserId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  let body: { newOwnerId: string; userId?: string; clearEndpoint?: number } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.newOwnerId) {
    return c.json(
      { error: { code: "MISSING_FIELDS", message: "newOwnerId is required" } },
      400,
    );
  }

  if (!isValidUserId(body.newOwnerId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  if (callerUserId !== record.ownerId) {
    return c.json(
      { error: { code: "NOT_OWNER", message: "只有管理者可以轉移管理權" } },
      403,
    );
  }

  // Use authenticated caller ID, not body.userId (which is kept for backwards compat)
  if (body.newOwnerId === callerUserId) {
    return c.json(
      { error: { code: "SAME_OWNER", message: "不能轉移給自己" } },
      400,
    );
  }

  if (!hasMember(record.members, body.newOwnerId)) {
    return c.json(
      { error: { code: "INVALID_MEMBER", message: "目標使用者不是家庭成員" } },
      400,
    );
  }

  record.ownerId = body.newOwnerId;
  if (body.clearEndpoint === 1) {
    delete record.apiEndpoint;
  }
  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: toPublicRecord(record) });
});

// PUT /api/family/:id/endpoint — update family API endpoint
familyRoutes.put("/:id/endpoint", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  const memberFamily = await c.env.KV.get(kvKeys.member(callerId));
  if (memberFamily !== familyId) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  let body: { apiEndpoint: string | null } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body || !("apiEndpoint" in body)) {
    return c.json(
      { error: { code: "MISSING_FIELDS", message: "apiEndpoint is required" } },
      400,
    );
  }

  if (typeof body.apiEndpoint === "string" && body.apiEndpoint.length > 2048) {
    return c.json(
      { error: { code: "INVALID_ENDPOINT", message: "API endpoint URL is too long" } },
      400,
    );
  }

  let normalizedEndpoint: string | null = null;

  if (body.apiEndpoint !== null) {
    if (typeof body.apiEndpoint !== "string") {
      return c.json(
        { error: { code: "INVALID_ENDPOINT", message: "apiEndpoint must be a string or null" } },
        400,
      );
    }

    let url: URL;
    try {
      url = new URL(body.apiEndpoint);
    } catch {
      return c.json(
        { error: { code: "INVALID_ENDPOINT", message: "apiEndpoint must be a valid URL" } },
        400,
      );
    }

    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
      return c.json(
        { error: { code: "INVALID_ENDPOINT", message: "API endpoint must use HTTPS (or HTTP for localhost)" } },
        400,
      );
    }

    // Block private/internal IPs (SSRF prevention)
    const hostname = url.hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipMatch) {
        const [, a, b] = ipMatch.map(Number);
        const isPrivate =
          a === 10 ||                          // 10.0.0.0/8
          (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
          (a === 192 && b === 168) ||          // 192.168.0.0/16
          (a === 169 && b === 254) ||          // 169.254.0.0/16 (link-local)
          a === 0;                             // 0.0.0.0/8
        if (isPrivate) {
          return c.json(
            { error: { code: "INVALID_ENDPOINT", message: "Private or internal IP addresses are not allowed" } },
            400,
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
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  if (callerId !== record.ownerId) {
    return c.json(
      { error: { code: "NOT_OWNER", message: "只有管理者可以修改 API 端點" } },
      403,
    );
  }

  if (normalizedEndpoint !== null) {
    record.apiEndpoint = normalizedEndpoint;
  } else {
    delete record.apiEndpoint;
  }

  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: toPublicRecord(record) });
});

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
