import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  BorrowStatus,
  type BorrowRequest,
  type FamilyMember,
  type KickedRecord,
  type RawFamilyRecord,
  type QrTokenRecord,
  type UserBooksRecord,
  normalizeFamilyRecord,
  hasMember,
  findMember,
  KICKED_TOMBSTONE_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
} from "../kv/schema";
import {
  isValidUserId,
  isValidFamilyId,
  isJsonObject,
  sanitizeDisplayName,
  sanitizeVerifySecret,
  validateDisplayName,
  sanitizeShortString,
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
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";

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
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: jsonRes("Joined family successfully"),
    400: jsonRes("Invalid input"),
    403: jsonRes("Verification failed, or member was removed by the owner"),
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
  description:
    "Owner-initiated removal of ANOTHER member (`uid` ≠ the authenticated " +
    "caller) writes a 6-hour kicked tombstone; while it lives, that user's " +
    "`POST /{id}/join` is refused with 403 `MEMBER_REMOVED`, including " +
    "reconnects and QR-token joins. A voluntary self-leave (`uid` = the " +
    "caller) writes no tombstone — leave-then-rejoin stays legitimate. The " +
    "tombstone is also written when the owner targets a userId that is not in " +
    "the family, so a retry after a partly-failed removal still applies the " +
    "ban even though the response is 404 `MEMBER_NOT_FOUND`. A removal made by " +
    "mistake does not have to be waited out: the owner can lift the ban at any " +
    "time with `DELETE /{id}/kicked/{uid}`.",
  request: {
    params: z.object({ id: z.string(), uid: z.string() }),
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
    params: z.object({ id: z.string(), uid: z.string() }),
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
    429: jsonRes("Rate limited"),
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
    429: jsonRes("Rate limited"),
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
    429: jsonRes("Rate limited"),
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

  // Bound the secret at the boundary, before any lookup: "" means not supplied,
  // null means present-but-malformed. Same classification in all three entry
  // points of the gate (see `sanitizeVerifySecret`).
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

  // --- Verification gate ---
  //
  // WHY: userId is sha256("moo:" + email) — derived from the user's email, so it
  // is publicly guessable — while `user:{userId}` (the personal book list,
  // including books the user never shared) persists across family changes and is
  // never deleted on leave. Minting an auth token for a userId without any proof
  // of ownership therefore hands anyone who knows the victim's email full
  // read/write access to those settings: account takeover. `POST /{id}/join`
  // already gates on this; create must match.
  //
  // Placement: AFTER the ALREADY_IN_FAMILY conflict check and BEFORE any KV
  // write or token mint — including the orphaned-member-key cleanup below — so a
  // failed attempt leaves nothing behind.
  //
  // The 409 above IS a small disclosure: it tells an unverified caller, as a
  // boolean, that this email's account currently belongs to some family. Kept
  // ahead of the gate deliberately, and matching `POST /{id}/join`, which
  // answers the same conflict the same way: the conflict is cheap and terminal
  // (no secret can make the request succeed), so gating first would only prompt
  // the user for a PIN, burn the account's verification attempt ceiling, and
  // then still refuse. What stays behind the gate is everything of value — the
  // familyId, the auth token, member data, and any write. Accepted residual
  // risk, documented in docs/architecture.md.
  //
  // Failures are charged to the CALLER's bucket, never to the target account
  // (see `validateVerification`). Accounts with no verification configured (or
  // method "none") pass through unchanged.
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
    verifySecret?: unknown;
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

  // Bound the secret at the boundary, alongside the other format checks and
  // before the verification gate: a malformed body is a request-format error and
  // must not reach hashSecret nor be charged against the verify attempt ceiling.
  // Same classification as create/lookup.
  const sanitizedSecret = sanitizeVerifySecret(body.verifySecret);
  if (sanitizedSecret === null) {
    return verifySecretFormatResponse(c);
  }
  const verifySecret = sanitizedSecret === "" ? undefined : sanitizedSecret;

  // Cheap, terminal conflict: the user already belongs to a DIFFERENT family, so
  // no secret can make this request succeed. Answered before the verification
  // gate (same ordering as `POST /api/family`) rather than after it, at the cost
  // of disclosing one boolean — "this userId is in some family" — to an
  // unverified caller. Everything of value stays behind the gate.
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
    // Failure accounting / lockout is charged to the CALLER (client IP, IPv6
    // bucketed per /64), never to the target account. This endpoint is public
    // and body.userId is derived from the user's email with a fixed salt, so a
    // LOCKOUT keyed on the victim would let any stranger lock them out of PWA
    // login on demand (DoS). Membership is NOT a usable trust signal here for
    // the same reason. Brute force from a SINGLE source stays bounded by the
    // per-IP sensitive-route limit (3/min); an attacker rotating source prefixes
    // is bounded by the "verify" attempt ceiling inside `validateVerification`
    // (10/hour, keyed on userId, shared with create and lookup). Unlike the
    // former standalone per-userId "join" counter — now removed — that ceiling is
    // charge-on-failure (the secret is compared first, only wrong guesses are
    // charged), so it never blocks the owner's own correct-secret reconnect.
    // No bound holds under DEV_MODE=1.
    const verification = await validateVerification(
      c.env,
      body.userId,
      verifySecret,
      { callerKey: getCallerIp(c) },
    );
    if (!verification.valid) {
      return verificationErrorResponse(c, verification.error);
    }
  }

  // --- Kicked tombstone gate ---
  //
  // The owner removed this userId from this family within the last
  // KICKED_TOMBSTONE_TTL_SECONDS. Refuse the (re)join for as long as the
  // tombstone lives; once it is gone — it expired, or the owner lifted the ban
  // via DELETE /api/family/:id/kicked/:uid — a sync-code rejoin is legitimate
  // again.
  //
  // Placement AFTER the verification gate is deliberate: backend rules forbid
  // new pre-gate disclosures. "This userId was recently removed from this
  // family" is therefore revealed only to a caller who passed the account's own
  // verification gate — or to an account with no verification configured, where
  // it discloses nothing the family record would not already.
  //
  // The check runs for BOTH the existing-member branch and the new-member
  // branch on purpose: while the tombstone lives, "still in the member list"
  // can only mean a stale KV read of the family record racing the removal write.
  // Denying the reconnect is the correct, fail-closed reading of the owner's
  // newer intent.
  //
  // It also deliberately applies to QR-token-bypass joins (`skipVerification`):
  // a QR token minted minutes before the kick must not outrank the kick.
  //
  // Cost: one extra small KV read per join, post-gate — acceptable on this
  // rate-limited sensitive-tier route.
  const kicked = await c.env.KV.get(kvKeys.kicked(familyId, body.userId));
  if (kicked !== null) {
    return jsonError(
      c,
      403,
      "MEMBER_REMOVED",
      "你已被管理者移出此家庭，暫時無法重新加入",
    );
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

  // Per-userId write ceiling: 30 family-domain writes per userId per hour,
  // shared by remove-member / un-kick / displayName / member-settings /
  // transfer / endpoint under one "family-write" scope. Layered on top of the
  // per-IP limit.
  //
  // Charged to the AUTHENTICATED caller, never to the `:uid` path param: a
  // counter keyed on someone else's id is a victim-facing DoS lever — the same
  // defect that got join's standalone per-userId counter removed. Create and
  // join stay out of this ceiling entirely; they are public sensitive-tier
  // routes bounded by the per-IP counter (3/min) plus the verification gate's
  // charge-on-failure attempt ceiling.
  //
  // Honest scope: this BOUNDS THE REQUEST RATE of a single authenticated
  // account's family-domain writes (30 admitted sequential requests + 30
  // counter writes per hour; parallel bursts overshoot by the caller's
  // concurrency — the counter is get-then-put, see middleware/rateLimit.ts).
  // It does NOT bound KV writes 1:1 — one admitted DELETE member fans out to
  // the family record put, the member key delete, both auth-token deletes, and
  // ONE put per cancelled PENDING borrow — and it does not make the daily
  // 1000-write free tier safe by itself. The per-IP middleware's own counter
  // write also lands BEFORE auth, so spam that ignores 429s still burns writes
  // outside this ceiling's reach. A hard global bound needs the edge
  // (Cloudflare WAF rate limiting, see docs/architecture.md and
  // worker/DEPLOY.md).
  //
  // Placement rule, uniform across all six handlers: the charge sits AFTER
  // every zero-I/O guard (path-format validation, the 401, and displayName's
  // pure self-only 403) and BEFORE the first KV read or body parse. A
  // permission check that needs a KV read therefore lands AFTER the charge —
  // that is why a non-owner's transfer / endpoint attempt spends its own slot
  // (pinned by the "charges the shared window even when the handler then
  // rejects" test). Same shape as user.ts / publicShelf.ts / verify.ts.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

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
    // Idempotent re-kick path. The member is already gone from the record, but
    // that does NOT mean a tombstone exists: the removal writes below are a
    // Promise.all, so a previous attempt may have half-failed (member dropped
    // from the family record, tombstone never written) and returned 500. Without
    // this write the owner's retry would 404 here — ahead of the tombstone block
    // — and the ban could never be applied, reopening the exact hole the
    // tombstone closes. It also lets an owner re-assert a kick whose tombstone
    // expired or whose write failed open below.
    //
    // Yes, this permits an owner to pre-tombstone a userId that never joined
    // their family. Scoped to their own familyId and squarely within their
    // authority (they may remove anyone from it at will), so harmless by design.
    //
    // Same discriminator as the post-removal write: the NOT_OWNER guard above
    // already proved the caller is the owner whenever targetUserId !== callerId,
    // and a self-targeted call is never a kick.
    if (targetUserId !== callerId) {
      await writeKickedTombstone(c.env.KV, familyId, targetUserId, callerId);
    }
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

  // Discriminator: this branch is shared by "voluntary self-leave" and "owner
  // removes another member" — everything above it (the NOT_OWNER guard) already
  // proved that when `targetUserId !== callerId` the caller IS the owner. A
  // voluntary self-leave must NOT be tombstoned: leave-then-rejoin is a
  // legitimate flow. The sole-member owner-dissolve path early-returns above and
  // never reaches here.
  //
  // Written SEQUENTIALLY AFTER the removal writes above, not inside them: if the
  // removal failed, a tombstone must not exist — it would lock a still-live
  // member out of reconnecting for the whole TTL.
  if (targetUserId !== callerId) {
    await writeKickedTombstone(c.env.KV, familyId, targetUserId, callerId);
  }

  return c.json({ data: record });
});

// DELETE /api/family/:id/kicked/:uid — owner lifts a removal ban (un-kick)
familyRoutes.openapi(clearKickedRoute, async (c) => {
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

  // Shared "family-write" per-userId write ceiling (30/hr across the six family
  // write handlers) — see the DELETE member handler for rationale. Charged to
  // the AUTHENTICATED caller, never to the `:uid` path param: a counter keyed
  // on someone else's id would be a victim-facing DoS lever. Same placement as
  // its siblings — after every zero-I/O guard, before the first KV read.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  if (callerId !== record.ownerId) {
    return jsonError(c, 403, "NOT_OWNER", "只有管理者可以解除移除限制");
  }

  // Idempotent by design: the tombstone is never read first, and deleting an
  // absent key is a no-op, so a retry after a failed call — or a call for a
  // userId that was never removed — behaves identically and answers 200. That
  // also means the response discloses nothing about whether the target was
  // kicked, to an owner who is by definition entitled to know anyway.
  //
  // Cross-family safety: the key is built from the path `id` the caller was
  // just proven to own, so this can only ever clear a tombstone of THIS family.
  //
  // Not a re-add: the user is merely allowed to join again, which they must do
  // themselves with the sync code (Invariant 4 stays intact).
  await c.env.KV.delete(kvKeys.kicked(familyId, targetUserId));

  return c.json({ data: { cleared: BoolFlag.TRUE } });
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

/**
 * Validate the `apiEndpoint` field of PUT /api/family/:id/endpoint and return
 * the value to persist (`null` clears the endpoint). Pure: no I/O and no
 * response building — the caller maps a failure onto `jsonError(c, 400, ...)`.
 */
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

  // The Worker itself never fetches this URL. The endpoint is redistributed
  // to every family member, so the threat is a family owner steering OTHER
  // members' clients at an address inside their own network. Reject the
  // literal address forms that make that attack cheap. Not a complete
  // defence, by design: a DNS name that resolves to an internal host is
  // indistinguishable from a legitimate one here, and IPv4 literals outside
  // the ranges below (e.g. 100.64.0.0/10 CGNAT / Tailscale, 224.0.0.0/4)
  // are not classified either. Both stay allowed.
  const hostname = url.hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    // The WHATWG URL parser keeps the brackets on an IPv6 host ("[::1]"), so
    // a leading "[" is a reliable marker. All IPv6 literals are rejected
    // rather than range-classified — that also covers IPv4-mapped forms such
    // as [::ffff:10.0.0.1], which would otherwise slip past the IPv4 check.
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

  // Shared "family-write" per-userId write ceiling (30/hr across the six family
  // write handlers) — see the DELETE member handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: callerId,
    ...FAMILY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const memberFamily = await c.env.KV.get(kvKeys.member(callerId));
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
 * Write the owner-initiated removal tombstone `kicked:{familyId}:{userId}`.
 *
 * WHY: without it the removal does not stick — the removed member's client
 * rejoins automatically with just `{ userId }` and is back in the family
 * seconds later. While the tombstone lives (`KICKED_TOMBSTONE_TTL_SECONDS`, 6h)
 * `POST /api/family/:id/join` refuses that userId with 403 MEMBER_REMOVED, in
 * the new-member branch, the existing-member reconnect branch, and
 * QR-token-bypass joins alike.
 *
 * Only ever called for `targetUserId !== callerId` — an owner removing ANOTHER
 * member. A voluntary self-leave must NOT be tombstoned (leave-then-rejoin is a
 * legitimate flow), and the sole-member owner-dissolve path never reaches a call
 * site. Enforcing that discriminator is the CALLER's job; this helper writes
 * unconditionally.
 *
 * Reversible before its TTL: the owner-only `DELETE /api/family/:id/kicked/:uid`
 * handler deletes the same key, so a removal made by mistake is undone on demand
 * instead of being waited out.
 *
 * FAIL-OPEN by design: a failed put is logged and swallowed, never surfaced as a
 * 500. On the post-removal call site the removal itself already succeeded and
 * reporting it as failed would be a lie; on the MEMBER_NOT_FOUND call site the
 * response is already an error. A missing tombstone only degrades to the
 * previous, weaker behaviour, and the owner's next DELETE retry re-attempts the
 * write via the idempotent re-kick path.
 *
 * Side effect: exactly one KV put. Never throws.
 */
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
    await kv.put(
      kvKeys.kicked(familyId, targetUserId),
      JSON.stringify(kickedRecord),
      { expirationTtl: KICKED_TOMBSTONE_TTL_SECONDS },
    );
  } catch (err) {
    console.error("KICK_TOMBSTONE_WRITE_FAILED", {
      familyId,
      targetUserId,
      err,
    });
  }
}

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

/**
 * Classify a user's current membership state for the family-create flow.
 *
 * - `"in-family"` — `member:{userId}` points at a live family record ⇒ creation
 *   must be rejected with ALREADY_IN_FAMILY.
 * - `"orphaned"` — the member key points at a family record that no longer
 *   exists ⇒ the stale key must be deleted before creating.
 * - `"none"` — no membership key at all.
 *
 * Read-only on purpose: the orphan cleanup write is left to the caller so it can
 * run AFTER the verification gate, keeping failed attempts side-effect free.
 */
async function classifyMembershipForCreate(
  kv: KVNamespace,
  userId: string,
): Promise<"in-family" | "orphaned" | "none"> {
  const existingFamilyId = await kv.get(kvKeys.member(userId));
  if (!existingFamilyId) return "none";

  const oldRaw = await kv.get<RawFamilyRecord>(
    kvKeys.family(existingFamilyId),
    "json",
  );
  return oldRaw ? "in-family" : "orphaned";
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
