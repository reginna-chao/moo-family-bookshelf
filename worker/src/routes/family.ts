import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import {
  BoolFlag,
  type FamilyMember,
  type KickedRecord,
  normalizeFamilyRecord,
  hasMember,
  findMember,
  TOKEN_TTL_SECONDS,
} from "../kv/schema";
import {
  getFamilyRecord,
  putFamilyRecord,
  deleteFamilyRecord,
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
import {
  deleteBorrowIndex,
  settleDepartingBorrower,
} from "../services/borrowIndex";
import { isLiveMembership } from "../services/membership";
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

/**
 * The join handler's `403 MEMBER_REMOVED` — one builder so the tombstone gate
 * and the post-write re-checks answer byte-identically.
 */
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

  // Sequential, pointer FIRST. KV has no transactions, so the order decides
  // which half-state a failure can leave. A failed family put after the pointer
  // landed leaves only an orphan `member:{uid}` (pointer → absent family), which
  // `classifyMembershipForCreate` reports as "orphaned" and this handler's retry
  // cleans up. The reverse order could leave a `family:{id}` nobody points at —
  // permanently unreachable, because the retry mints a fresh familyId.
  await putMemberFamilyId(c.env.KV, body.userId, familyId);
  await putFamilyRecord(c.env.KV, familyId, record);

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
  // of disclosing one boolean — "this userId is listed in a live family" — to an
  // unverified caller; no more than before. Everything of value stays behind the
  // gate.
  //
  // A STALE pointer does not count as membership (`isLiveMembership`, the rule
  // shared with create and lookup in `services/membership.ts`): one
  // at a family record that no longer exists (an ORPHAN, left by a create or
  // dissolve that failed halfway — both order their writes so that this is the
  // only half-state they can leave), or at a family that no longer lists the
  // user (a join that raced a kick, a stale read at the removal). The join
  // continues, and the new-member pointer put overwrites it on success. No
  // delete here — nothing may be written before the gate. The extra family read
  // happens on this conflict path only.
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
    const qrRecord = await getQrTokenRecord(c.env.KV, body.qrToken);
    if (qrRecord && qrRecord.userId === body.userId) {
      skipVerification = true;
      // One-time use: delete immediately
      await deleteQrToken(c.env.KV, body.qrToken);
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
  // can only mean a removal still in flight (it writes the tombstone first), a
  // removal that failed after its tombstone, or a stale KV read of the family
  // record. Denying the reconnect is the correct, fail-closed reading of the
  // owner's newer intent.
  //
  // It also deliberately applies to QR-token-bypass joins (`skipVerification`):
  // a QR token minted minutes before the kick must not outrank the kick.
  //
  // Cost: one extra small KV read per join, post-gate — acceptable on this
  // rate-limited sensitive-tier route.
  const kicked = await hasKickedTombstone(c.env.KV, familyId, body.userId);
  if (kicked) {
    return memberRemovedResponse(c);
  }

  if (isExistingMember) {
    // Heal a missing or stale pointer: the record lists this user but
    // `member:{uid}` does not name this family. The pre-gate check above let
    // only three shapes through to here — no pointer, an orphan (record gone),
    // or one at a family that no longer lists the user — and overwriting is
    // right for all three. The usual source is a new-member join whose pointer
    // put failed after the record put (see below). `member:{uid}` is checked
    // first by bookshelf / members / auth refresh, so without this write the
    // reconnect would mint a token that cannot read the family.
    //
    // A heal must not land for a member whose removal is in flight — combined
    // with any concurrent stale-list write re-listing them, it would be a full
    // re-admission. The tombstone gate above cannot guarantee that alone: when
    // the target was ALREADY pointerless (an earlier half-failed self-leave or
    // join), this handler can pass the gate before the owner's tombstone lands,
    // the owner's pointer read then sees null and deletes nothing, and the heal
    // put lands after it. So the guarantee is a PAIR of mirrored orders: the
    // removal writes the tombstone, THEN reads the pointer; the heal writes the
    // pointer, THEN re-reads the tombstone (`retractPointerIfKicked`). Under
    // same-colo read-your-writes at least one side observes the other — the
    // removal's pointer read sees the healed pointer and deletes it, or the
    // re-check sees the tombstone and this handler retracts its own pointer
    // and answers 403 MEMBER_REMOVED before any token is minted. Cross-colo
    // propagation is the documented ~60s residual, as is a tombstone put that
    // failed open. Cost: one extra read, on this rare heal path only.
    //
    // Defence in depth: a healing reconnect still NEVER writes the family
    // record back — not even for a changed displayName — since `record` may
    // predate a concurrent removal's put, and with no CAS a stale-record put
    // would re-list the target together with the pointer healed here. The
    // displayName catches up on the next, non-healing reconnect or via the
    // displayName endpoint.
    //
    // Reuses the pointer read from the top of the handler to decide whether to
    // heal, and runs only after the verification and kicked-tombstone gates.
    const healsPointer = existingFamily !== familyId;
    if (healsPointer) {
      await putMemberFamilyId(c.env.KV, body.userId, familyId);
      if (await retractPointerIfKicked(c.env.KV, familyId, body.userId)) {
        return memberRemovedResponse(c);
      }
    }

    // Update displayName if changed — non-healing reconnects only (see above).
    const member = findMember(record.members, body.userId);
    if (
      !healsPointer &&
      member &&
      displayName !== "" &&
      member.displayName !== displayName
    ) {
      member.displayName = displayName;
      await putFamilyRecord(c.env.KV, familyId, record);
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

  // Sequential, family record FIRST. If the pointer put then fails, the user is
  // listed without a pointer; the retry finds them in the member list, takes the
  // existing-member branch above and heals the pointer there. The reverse order
  // could leave a pointer at a family that does not list the user; if that
  // family then filled up, this join answers FAMILY_FULL while the live pointer
  // makes create and every other join answer ALREADY_IN_FAMILY — stuck for good.
  await putFamilyRecord(c.env.KV, familyId, record);
  await putMemberFamilyId(c.env.KV, body.userId, familyId);

  // Same mirrored-order re-check as the heal above: an owner who saw this
  // record put and kicked writes the tombstone before reading the pointer, so
  // either that read deletes the pointer just written or this re-check sees
  // the tombstone. On retraction the member-list entry stays — the in-flight
  // kick's own list put removes it (or, after a pre-emptive 404 re-kick, the
  // owner sees them listed and removes them again); no token is minted. Cost:
  // one extra small read per new-member join, a rare sensitive-tier request.
  if (await retractPointerIfKicked(c.env.KV, familyId, body.userId)) {
    return memberRemovedResponse(c);
  }

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
  // at most ONE borrow-index put plus one pointer delete per evicted record —
  // and it does not make the daily 1000-write free tier safe by itself. The
  // per-IP middleware's own counter write also lands BEFORE auth, so spam that
  // ignores 429s still burns writes outside this ceiling's reach. A hard
  // global bound needs the edge (Cloudflare WAF rate limiting, see
  // docs/architecture.md and worker/DEPLOY.md).
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

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Owner trying to leave: allow only when they are the sole member
  if (callerId === record.ownerId && targetUserId === callerId) {
    if (record.members.length > 1) {
      return jsonError(c, 403, "OWNER_CANNOT_LEAVE", "請先轉移管理權後再離開");
    }

    // Single-member owner: delete entire family, borrow index included.
    //
    // The index is dropped FAIL-OPEN and BEFORE the dissolve, deliberately: it
    // is cleanup, not part of the dissolve's meaning, so it must never keep an
    // owner in a family they asked to leave — a caught throw is logged and the
    // dissolve proceeds, so the order helps only when the request is cut short
    // before the family delete: the family key is still there, so the dissolve
    // can be retried. Without it the index outlives the family as a permanent
    // orphan — the reclaim gap the departure purge closes on the other side.
    try {
      await deleteBorrowIndex(c.env.KV, familyId);
    } catch (err) {
      console.error("BORROW_INDEX_DELETE_FAILED", { familyId, err });
    }

    // Family record FIRST, then the caller's pointer and token. A failure after
    // the family delete leaves only an orphan pointer, which create cleans up
    // ("orphaned") and join treats as no membership. The reverse order could
    // leave a `family:{id}` that nobody points at, permanently.
    await deleteFamilyRecord(c.env.KV, familyId);
    await Promise.all([
      deleteMemberFamilyId(c.env.KV, callerId),
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
    // Idempotent re-kick path, tombstone FIRST — before the stray-pointer
    // delete below, for the same reason the removal below writes it before its
    // revoke: a join that observes the deleted pointer must also observe the
    // tombstone, so it answers 403 MEMBER_REMOVED instead of healing the
    // pointer back. The member is already gone from the record, but that does
    // NOT mean a tombstone exists: a previous removal's tombstone put may have
    // failed open while its revoke and family put landed, or the tombstone has
    // expired. Without this write the owner's retry would 404 here — ahead of
    // the removal's tombstone write — and the ban could never be applied.
    //
    // Yes, this permits an owner to pre-tombstone a userId that never joined
    // their family. Scoped to their own familyId and squarely within their
    // authority (they may remove anyone from it at will), so harmless by design.
    //
    // Same discriminator as the removal: the NOT_OWNER guard above already
    // proved the caller is the owner whenever targetUserId !== callerId, and a
    // self-targeted call is never a kick (stray cleanup only, no tombstone).
    if (targetUserId !== callerId) {
      await writeKickedTombstone(c.env.KV, familyId, targetUserId, callerId);
    }

    // Stray-pointer cleanup. The record no longer lists the target, yet
    // `member:{uid}` may still name this family: a stale pointer read at the
    // removal's revoke (KV ~60s propagation), a join that healed the pointer
    // during a removal whose tombstone put failed open, or a pre-#213 removal
    // that half-failed. The read-side list checks already deny that pointer any
    // bookshelf / members read; deleting it here is what makes the owner's
    // re-kick — or the target's own retried leave — converge. Runs for BOTH
    // callers: the NOT_OWNER guard above already proved the caller is the owner
    // or the target is themself. One extra read, on this rare branch only; a
    // pointer naming another family is left alone.
    const strayPointer = await getMemberFamilyId(c.env.KV, targetUserId);
    if (strayPointer === familyId) {
      await Promise.all([
        deleteMemberFamilyId(c.env.KV, targetUserId),
        deleteAuthToken(c.env.KV, targetUserId),
      ]);
    }
    return jsonError(c, 404, "MEMBER_NOT_FOUND", "目標使用者不是家庭成員");
  }

  // Settle the departing member's borrow records FIRST, before mutating the
  // family record: cancel the PENDING requests they are a party to, then drop
  // their own finished ones from the index (see settleDepartingBorrower). If
  // this throws, the family record is untouched and the caller can retry safely
  // without leaving partial state.
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

  record.members = record.members.filter((m) => m.userId !== targetUserId);

  // Owner kick: tombstone FIRST — after the borrow settlement (whose 500 must
  // leave nothing written) and BEFORE the revoke. Discriminator: this branch is
  // shared by "voluntary self-leave" and "owner removes another member";
  // the NOT_OWNER guard above already proved that when `targetUserId !==
  // callerId` the caller IS the owner. A voluntary self-leave is never
  // tombstoned (leave-then-rejoin is legitimate), and the sole-member
  // owner-dissolve path early-returns above and never reaches here.
  //
  // Why first: the join handler reads `member:{uid}` BEFORE it checks the
  // tombstone. With the tombstone landed before the pointer delete, any join
  // that observes the deleted pointer — the only kind that would HEAL it —
  // also observes the tombstone and answers 403 MEMBER_REMOVED. Tombstone-last
  // left a window (pointer gone, list not yet written, no tombstone) in which
  // a join saw itself listed and healed the pointer, and any concurrent
  // full-record write carrying the stale list (a displayName reconnect, the
  // displayName / member-settings endpoints) could then re-list the target
  // after our put: listed + pointer + token = a full re-admission. Ordering
  // alone does not cover a target who was ALREADY pointerless (a join can pass
  // its gate before our tombstone, our pointer read below sees null, and its
  // heal lands after that read), so the join handler mirrors this order — it
  // re-reads the tombstone AFTER writing the pointer and retracts it
  // (`retractPointerIfKicked`); the pair means one side always sees the other.
  // This holds under same-colo read-your-writes; across colos KV
  // propagates each key independently, which is the ~60s propagation residual
  // documented in docs/architecture.md.
  //
  // Trade-off, deliberately accepted: this reverses the former "tombstone only
  // after the removal writes succeed" rule. If the revoke or the family put
  // below throws (500), the target is still listed but cannot reconnect for
  // up to KICKED_TOMBSTONE_TTL_SECONDS. That protected a still-live member,
  // but a member the owner is actively kicking is not one the owner wants
  // reconnecting — the owner still sees them listed, and either a retried
  // removal converges or `DELETE /api/family/:id/kicked/:uid` lifts the ban.
  // The helper stays fail-open: a failed tombstone put must not stop the
  // removal itself (Inv-4), at the cost of reopening the heal window for that
  // one removal; the owner's re-kick re-attempts the write.
  if (targetUserId !== callerId) {
    await writeKickedTombstone(c.env.KV, familyId, targetUserId, callerId);
  }

  // Revoke, then update the member list. `member:{uid}` is what
  // `POST /api/auth/refresh` checks, so the old order (all three writes in
  // parallel) could leave a pointer at a family that no longer lists the target
  // — a removed member who keeps refreshing tokens. With revoke-first, a
  // failure after the deletes leaves the target with no pointer and no token
  // but still listed: the owner still sees them, and a retry finds them a
  // member and converges. A stray pointer that survives anyway (a stale read
  // below) grants no family read — the bookshelf / members reads re-check the
  // list — and the MEMBER_NOT_FOUND branch above deletes it on the re-kick.
  //
  // What this ordering does NOT close: `family:{id}` is a read-modify-write
  // with no CAS, so a concurrent full-record write that read the list before
  // our put (a non-healing reconnect carrying a new displayName, the
  // displayName / member-settings endpoints — started before the tombstone
  // landed) can still re-list the target after it. That member has no pointer,
  // so the bookshelf / members reads stay closed, but a reconnect that read the
  // pointer before the revoke still mints a fresh token, and the borrow routes
  // and member-settings check the member list only — such a hollow member can
  // read the family borrow list, and their shared books appear in the others'
  // bookshelf aggregation, until the owner removes them again. This race
  // predates #213; see docs/architecture.md → 已接受的殘餘風險.
  //
  // The pointer is read first and the deletes run only when it names THIS
  // family. Anything else (null, or another family) means the target's session
  // belongs elsewhere — e.g. they were left listed-but-pointerless by an earlier
  // half-failed removal and have since created or joined another family — and
  // must not be clobbered.
  const targetPointer = await getMemberFamilyId(c.env.KV, targetUserId);
  if (targetPointer === familyId) {
    await Promise.all([
      deleteMemberFamilyId(c.env.KV, targetUserId),
      deleteAuthToken(c.env.KV, targetUserId),
    ]);
  }
  await putFamilyRecord(c.env.KV, familyId, record);

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

  const raw = await getFamilyRecord(c.env.KV, familyId);

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
  await deleteKickedTombstone(c.env.KV, familyId, targetUserId);

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

  const memberFamily = await getMemberFamilyId(c.env.KV, userId);
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  // Same re-check as the bookshelf read: a pointer naming this family is not
  // enough once the record no longer lists the caller (a join racing a kick, a
  // stale pointer read at the removal). Zero extra reads; byte-identical to the
  // pointer-mismatch 404 above.
  if (!hasMember(record.members, userId)) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

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

  const raw = await getFamilyRecord(c.env.KV, familyId);

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const record = normalizeFamilyRecord(raw);

  const member = findMember(record.members, targetUserId);
  if (!member) {
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

  const raw = await getFamilyRecord(c.env.KV, familyId);
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

  await putFamilyRecord(c.env.KV, familyId, record);

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

  const raw = await getFamilyRecord(c.env.KV, familyId);

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
  await putFamilyRecord(c.env.KV, familyId, record);

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
 * Both call sites write it BEFORE revoking the target's pointer (see the removal
 * handler for why), so a failed kick can leave a tombstone for a member who is
 * still listed — accepted: the owner retries or lifts it via the un-kick route.
 *
 * FAIL-OPEN by design: a failed put is logged and swallowed, never surfaced as a
 * 500. On the removal call site a failed tombstone must not stop the removal
 * itself (Invariant 4 requires it to happen immediately); on the
 * MEMBER_NOT_FOUND call site the response is already an error. A missing
 * tombstone only degrades to the previous, weaker behaviour, and the owner's
 * next DELETE retry re-attempts the write via the idempotent re-kick path.
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
    await putKickedTombstone(kv, familyId, targetUserId, kickedRecord);
  } catch (err) {
    console.error("KICK_TOMBSTONE_WRITE_FAILED", {
      familyId,
      targetUserId,
      err,
    });
  }
}

/**
 * Join-side half of the kick ordering: called right AFTER the join handler has
 * put `member:{userId}` → familyId (heal or new member). Re-reads the kicked
 * tombstone; if one has landed since the join's tombstone gate, deletes the
 * pointer this request just wrote and returns `true` so the caller answers
 * 403 MEMBER_REMOVED without minting a token.
 *
 * Mirrors the removal's "tombstone put → pointer read": the join writes the
 * pointer, then reads the tombstone. Under same-colo read-your-writes at least
 * one of the two reads observes the other side's write, so a pointer can no
 * longer be healed back past an in-flight kick unnoticed.
 *
 * Side effects: one KV get; plus one KV delete only when the tombstone exists.
 */
async function retractPointerIfKicked(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<boolean> {
  if (!(await hasKickedTombstone(kv, familyId, userId))) {
    return false;
  }
  await deleteMemberFamilyId(kv, userId);
  return true;
}

/**
 * Classify a user's current membership state for the family-create flow.
 *
 * - `"in-family"` — `member:{userId}` points at a live family record that lists
 *   the user ⇒ creation must be rejected with ALREADY_IN_FAMILY.
 * - `"orphaned"` — the member key is stale (see `isLiveMembership` in
 *   `services/membership.ts`) ⇒ it must
 *   be deleted before creating. Two shapes: the pointed family record no longer
 *   exists — exactly the half-state a create (pointer put, then family put) or
 *   a sole-owner dissolve (family delete, then pointer delete) leaves when it
 *   fails between its two writes; or the record exists but no longer lists the
 *   user — a join that raced a kick, or a stale pointer read at the removal.
 * - `"none"` — no membership key at all.
 *
 * Read-only on purpose: the orphan cleanup write is left to the caller so it can
 * run AFTER the verification gate, keeping failed attempts side-effect free.
 */
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
