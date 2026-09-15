import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { isAllowedCoverUrl } from "moo-family-bookshelf-shared/config/readmoo";
import type { Env } from "../utils/env";
import {
  BoolFlag,
  BorrowStatus,
  BORROW_MAX_PENDING_PER_BORROWER,
  type BorrowRequest,
  type FamilyMember,
  normalizeFamilyRecord,
  hasMember,
  findMember,
} from "../kv/schema";
import { getFamilyRecord } from "../kv/families";
import {
  readBorrowIndex,
  readBorrowPointer,
  writeBorrowIndex,
  writeBorrowPointer,
} from "../services/borrowIndex";
import {
  isValidFamilyId,
  isValidUserId,
  isValidRequestId,
  BORROW_BOOK_ID_MAX_LENGTH,
  BORROW_BOOK_TITLE_MAX_LENGTH,
  BORROW_BOOK_AUTHOR_MAX_LENGTH,
  BORROW_COVER_URL_MAX_LENGTH,
} from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError, type ErrorBody } from "../utils/errors";
import { FamilyIdParam, RequestIdParamObj } from "../schemas/common";

export const borrowRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

/** Check if a member has lending enabled (treat missing/undefined as TRUE for backward compat). */
function isMemberLendingEnabled(member: FamilyMember): boolean {
  return member.canLend !== BoolFlag.FALSE;
}

/**
 * Classify the OPTIONAL `bookCoverUrl` at the handler boundary, mirroring
 * `sanitizeVerifySecret()` in `utils/validation.ts`:
 *
 * - absent / `null` / `""` ⇒ "no cover", normalized to `""` (a book whose cover
 *   the bookshelf aggregation sanitized away must still be borrowable);
 * - any other non-string ⇒ `null`, i.e. a request-format error (`400
 *   INVALID_FIELDS`) — never a cover-whitelist rejection;
 * - a non-empty string is returned verbatim for the whitelist check.
 *
 * `BorrowRequest.bookCoverUrl` stays a non-optional `string`, so the stored
 * record never carries `undefined` / `null`.
 */
function normalizeBookCoverUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  return value;
}

// --- Route definitions ---

const createBorrowRoute = createRoute({
  method: "post",
  path: "/family/{id}/borrow",
  tags: ["Borrow"],
  summary: "Create a borrow request",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    201: jsonRes("Borrow request created"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family not found"),
    409: jsonRes("Too many pending borrow requests"),
    429: jsonRes("Rate limited"),
    500: jsonRes("Internal error"),
  },
});

const listBorrowRoute = createRoute({
  method: "get",
  path: "/family/{id}/borrow",
  tags: ["Borrow"],
  summary: "List family borrow requests",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("List of borrow requests"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Family not found"),
    429: jsonRes("Rate limited"),
  },
});

const updateBorrowRoute = createRoute({
  method: "patch",
  path: "/borrow/{requestId}",
  tags: ["Borrow"],
  summary: "Update borrow request status",
  request: {
    params: RequestIdParamObj,
  },
  responses: {
    200: jsonRes("Updated borrow request"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    404: jsonRes("Request not found"),
    422: jsonRes("Invalid status transition"),
    429: jsonRes("Rate limited"),
  },
});

// --- Handlers ---

// POST /api/family/:id/borrow — create borrow request
borrowRoutes.openapi(createBorrowRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Raw parsed-JSON shape: `bookCoverUrl` is optional AND unconstrained, so it
  // is typed `unknown` and narrowed by `normalizeBookCoverUrl` below.
  let body: {
    bookId?: string;
    bookTitle?: string;
    bookAuthor?: string;
    bookCoverUrl?: unknown;
    ownerId?: string;
  } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body?.bookId || !body.bookTitle || !body.bookAuthor || !body.ownerId) {
    return jsonError(
      c,
      400,
      "MISSING_FIELDS",
      "bookId, bookTitle, bookAuthor, and ownerId are required",
    );
  }

  // `bookCoverUrl` is optional, but a SUPPLIED value of the wrong type is still
  // a format error — classified in the same guard slot as the required fields
  // so it keeps its INVALID_FIELDS precedence over INVALID_USER_ID /
  // INVALID_COVER_URL. `null` here means "wrong type", not "no cover".
  const bookCoverUrl = normalizeBookCoverUrl(body.bookCoverUrl);

  // Type AND length in one guard slot. The length half is not cosmetic: every
  // record of a family now lives inside ONE KV value (borrows:family:{id})
  // that every member reads on every list, so an unbounded field is a way for
  // one member to inflate what the whole family pays for. Both halves run
  // BEFORE the rate-limit charge — a malformed request must not burn quota.
  if (
    typeof body.bookId !== "string" ||
    typeof body.bookTitle !== "string" ||
    typeof body.bookAuthor !== "string" ||
    typeof body.ownerId !== "string" ||
    bookCoverUrl === null ||
    body.bookId.length > BORROW_BOOK_ID_MAX_LENGTH ||
    body.bookTitle.length > BORROW_BOOK_TITLE_MAX_LENGTH ||
    body.bookAuthor.length > BORROW_BOOK_AUTHOR_MAX_LENGTH ||
    bookCoverUrl.length > BORROW_COVER_URL_MAX_LENGTH
  ) {
    return jsonError(
      c,
      400,
      "INVALID_FIELDS",
      "All fields must be strings within length limits",
    );
  }

  if (!isValidUserId(body.ownerId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "ownerId format is invalid");
  }

  // The cover URL is stored verbatim and later rendered into an <img src> by
  // the PWA / Extension, so an arbitrary URL from a family member would be a
  // privacy tracking beacon (it leaks the viewer's IP + UA to the attacker on
  // every render). Restrict it to Readmoo-served https covers at the boundary.
  // Runs before the rate-limit charge: a malformed request is a format error
  // and must not burn the caller's quota (same rule as `verifySecret`).
  // Only the EMPTY case is exempt, and it does not weaken the control: the
  // family-bookshelf aggregation sanitizes every off-whitelist cover to "", so
  // "" reaching this handler means "this book has no renderable cover" — a
  // legitimate signal, not an attack. Every NON-EMPTY value still runs the
  // whitelist.
  if (bookCoverUrl !== "" && !isAllowedCoverUrl(bookCoverUrl)) {
    return jsonError(
      c,
      400,
      "INVALID_COVER_URL",
      "bookCoverUrl must be an https URL on a Readmoo host",
    );
  }

  // Capture validated fields into locals (narrows types for the rest of the handler)
  const bookId = body.bookId;
  const ownerId = body.ownerId;

  // Per-user rate limit
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    scope: "borrow-create",
    max: 10,
    windowSec: 60,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // Load family record
  const raw = await getFamilyRecord(c.env.KV, familyId);
  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const family = normalizeFamilyRecord(raw);

  // Verify caller is a family member
  if (!hasMember(family.members, userId)) {
    return jsonError(
      c,
      403,
      "NOT_FAMILY_MEMBER",
      "You are not a member of this family",
    );
  }

  // Verify ownerId is a different family member. The two rejections below carry
  // DISTINCT codes on purpose: clients see only the `code` and map each to its
  // own copy. The self branch is unreachable today only because both UIs hide
  // the borrow button for one's own books — do NOT re-merge the two codes.
  if (ownerId === userId) {
    return jsonError(
      c,
      403,
      "INVALID_OWNER_SELF",
      "Cannot borrow your own book",
    );
  }

  if (!hasMember(family.members, ownerId)) {
    return jsonError(
      c,
      403,
      "INVALID_OWNER",
      "Owner is not a member of this family",
    );
  }

  // Check canLend for both parties
  const borrowerMember = findMember(family.members, userId);
  const ownerMember = findMember(family.members, ownerId);
  if (!borrowerMember || !ownerMember) {
    return jsonError(c, 500, "INTERNAL_ERROR", "Member lookup failed");
  }

  if (
    !isMemberLendingEnabled(borrowerMember) ||
    !isMemberLendingEnabled(ownerMember)
  ) {
    return jsonError(
      c,
      403,
      "LENDING_DISABLED",
      "Lending is disabled for one or both members",
    );
  }

  // The family's borrow index carries the full records, so the duplicate check
  // reads ONE key. A legacy string[] index still fans out here, one last time
  // — the write below rewrites it in the new shape.
  const { requests } = await readBorrowIndex(c.env.KV, familyId);

  // Check for duplicate PENDING request (same borrowerId + bookId)
  const hasDuplicate = requests.some(
    (req) =>
      req.borrowerId === userId &&
      req.bookId === bookId &&
      req.status === BorrowStatus.PENDING,
  );

  if (hasDuplicate) {
    return jsonError(
      c,
      400,
      "DUPLICATE_REQUEST",
      "A pending borrow request already exists for this book",
    );
  }

  // Per-borrower ceiling on OPEN requests. PENDING records are exempt from the
  // history trim (evicting one would strand a request the owner still has to
  // answer), so without this they are the one part of the index a single member
  // can grow without bound — and the index is one KV value the whole family
  // reads on every list. Counted from the caller's OWN records only, so no one
  // else's traffic can spend it (Inv-6), and the caller clears it themselves by
  // cancelling or by the owner answering. Placed after the membership and
  // duplicate checks: it needs the index that was just read, and it must not
  // pre-empt the more specific errors above.
  const openByCaller = requests.filter(
    (req) => req.status === BorrowStatus.PENDING && req.borrowerId === userId,
  ).length;

  if (openByCaller >= BORROW_MAX_PENDING_PER_BORROWER) {
    return jsonError(
      c,
      409,
      "TOO_MANY_PENDING_REQUESTS",
      "Too many pending borrow requests; resolve or cancel some first",
    );
  }

  // Create the borrow request
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();

  const borrowRequest: BorrowRequest = {
    requestId,
    familyId,
    borrowerId: userId,
    borrowerName: borrowerMember.displayName,
    ownerId,
    bookId,
    bookTitle: body.bookTitle,
    bookAuthor: body.bookAuthor,
    // Normalized above: "" when no cover was supplied, never undefined/null.
    bookCoverUrl,
    status: BorrowStatus.PENDING,
    createdAt: now,
    updatedAt: now,
  };

  // NOTE: No atomic CAS in KV. The index is a read-modify-write of ONE key on
  // every write path — create (here), PATCH, and the departure settlement
  // (`settleDepartingBorrower`, from member removal in family.ts and account
  // deletion in user.ts) — so two concurrent writers on the SAME family can
  // both read the same index and the second put overwrites the first, losing
  // the earlier update. That lost update is the remaining residual and it is
  // ACCEPTED: see docs/architecture.md → 已接受的殘餘風險.
  //
  // What is NO LONGER a residual: an index that grows with history. The old
  // form of this note called the tradeoff "acceptable only while the index
  // stays under 20 entries" and left that bound to a reviewer's judgement.
  // `trimBorrowIndex` (services/borrowIndex.ts) now enforces it on every write
  // — the index holds the live requests plus at most BORROW_HISTORY_KEEP
  // terminal ones PER BORROWER. Live requests are deliberately NOT trimmed
  // (evicting one would strand a lent book), so the bound is "live + 20 per
  // borrower", not a constant; the PENDING half of "live" is bounded instead at
  // the boundary above, by BORROW_MAX_PENDING_PER_BORROWER.
  //
  // The cap is not the only thing that shrinks the index, and it could not be:
  // it is keyed on `borrowerId`, and a sync-code holder can mint fresh
  // borrowerIds indefinitely (join → open requests → leave → repeat), each
  // leaving a group under the cap that no later write would ever trim. So
  // BORROWER COUNT is bounded too, at both exits: `settleDepartingBorrower`
  // removes a departing member's own terminal records (not LENT — see its
  // JSDoc tripwire), and `deleteBorrowIndex` drops the key on dissolve.
  // tests/integration/budget/borrow-index-growth.test.ts remains the
  // acceptance criterion for the O(1) list read.
  //
  // For strict correctness, scope index per-borrower or use Durable Objects.
  //
  // Write order is SEQUENTIAL and deliberate, and the POINTER goes FIRST —
  // the two half-failures are NOT symmetric:
  //   - index entry without pointer: a PENDING ghost. Both parties SEE it in
  //     the list, but PATCH cannot resolve its family, so every attempt to
  //     approve / reject / cancel it answers 404. PENDING is never trimmed, so
  //     it stays forever, and it permanently blocks re-requesting the same book
  //     (DUPLICATE_REQUEST matches on borrowerId + bookId + PENDING).
  //   - pointer without index entry: invisible to every reader and harmless.
  //     The requestId is a freshly minted UUID nothing else names, a PATCH on
  //     it gets the same 404 an unknown id gets, and the caller's retry creates
  //     a clean record under a new id.
  // So the recoverable half is written first: whichever write fails, no ghost
  // can exist.
  await writeBorrowPointer(c.env.KV, requestId, familyId);

  await writeBorrowIndex(c.env.KV, familyId, [...requests, borrowRequest]);

  return c.json({ data: borrowRequest }, 201);
});

// GET /api/family/:id/borrow — list family borrow requests
borrowRoutes.openapi(listBorrowRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    scope: "borrow-list",
    max: 60,
    windowSec: 60,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // Verify caller is a family member
  const raw = await getFamilyRecord(c.env.KV, familyId);
  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const family = normalizeFamilyRecord(raw);
  if (!hasMember(family.members, userId)) {
    return jsonError(
      c,
      403,
      "NOT_FAMILY_MEMBER",
      "You are not a member of this family",
    );
  }

  // Load the borrow index. READ-ONLY on purpose, including for a family still
  // on the legacy string[] index (which fans out here exactly as before):
  // migration is write-path only, so a listing never writes — see
  // services/borrowIndex.ts.
  const { requests } = await readBorrowIndex(c.env.KV, familyId);

  // API-layer least privilege: only records the caller is a party to are
  // returned. A family member who is neither borrower nor owner has no claim to
  // someone else's transaction, and this is what keeps FORMER members' data
  // (userId, borrowerName, bookTitle, bookAuthor, bookCoverUrl) out of
  // uninvolved members' responses — a departure does not empty the index of
  // that member: `settleDepartingBorrower` removes only the terminal records
  // they BORROWED, leaving their LENT ones (still out on loan) and every record
  // where they were the OWNER, which is the remaining member's own history.
  //
  // Nothing downstream needs third-party records: both clients already bucket
  // exclusively by `ownerId === userId || borrowerId === userId` (extension
  // BorrowTab.tsx, PWA BorrowPage.tsx; the `pendingBookIds` sets in both
  // FamilyShelf pages collect only the caller's own PENDING requests), and the
  // create handler's DUPLICATE_REQUEST check reads KV directly rather than this
  // response.
  const visibleRequests = requests.filter(
    (r) => r.borrowerId === userId || r.ownerId === userId,
  );

  return c.json({ data: visibleRequests });
});

// PATCH /api/borrow/:requestId — update borrow status
borrowRoutes.openapi(updateBorrowRoute, async (c) => {
  const requestId = c.req.param("requestId");

  if (!isValidRequestId(requestId)) {
    return jsonError(
      c,
      400,
      "INVALID_REQUEST_ID",
      "Request ID format is invalid",
    );
  }

  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  let body: { status?: number } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (body?.status === undefined || body.status === null) {
    return jsonError(c, 400, "MISSING_FIELDS", "status is required");
  }

  if (typeof body.status !== "number" || !Number.isInteger(body.status)) {
    return jsonError(c, 400, "INVALID_FIELDS", "status must be an integer");
  }

  const targetStatus = body.status;

  // Per-user rate limit
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    scope: "borrow-update",
    max: 30,
    windowSec: 60,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // A bare requestId cannot name its family, so resolve the pointer first.
  // It reads a legacy full record for its `familyId` too, and NEVER rewrites
  // one — the index is the truth for the record's contents.
  const familyId = await readBorrowPointer(c.env.KV, requestId);
  if (!familyId) {
    return jsonError(c, 404, "REQUEST_NOT_FOUND", "Borrow request not found");
  }

  // The entry inside the index IS the record; `borrowRequest` is a reference
  // into `requests`, so mutating it below updates what gets written back.
  const { requests } = await readBorrowIndex(c.env.KV, familyId);
  const borrowRequest = requests.find((r) => r.requestId === requestId);
  if (!borrowRequest) {
    // The record aged out of its borrower's history cap, or this is an orphan
    // pointer: either the trim's fail-open delete did not land, or a create
    // wrote the pointer and then failed to write the index. All of them mean
    // "no such request" — same 404 as an unknown requestId, so the response
    // discloses nothing extra.
    return jsonError(c, 404, "REQUEST_NOT_FOUND", "Borrow request not found");
  }

  // Defence in depth: the pointer and the record must name the SAME family.
  // They disagree only if one of the two is corrupt, and acting on that would
  // rewrite this family's whole index from a record that claims to belong to
  // another one. Refuse with the same 404 an unknown requestId gets — it
  // discloses nothing extra — and write nothing.
  if (borrowRequest.familyId !== familyId) {
    return jsonError(c, 404, "REQUEST_NOT_FOUND", "Borrow request not found");
  }

  // Validate caller is either borrower or owner
  const isBorrower = userId === borrowRequest.borrowerId;
  const isOwner = userId === borrowRequest.ownerId;

  if (!isBorrower && !isOwner) {
    return jsonError(
      c,
      403,
      "FORBIDDEN",
      "You are not authorized to update this request",
    );
  }

  // Validate status transition (FSM)
  const transitionError = validateStatusTransition(
    borrowRequest.status,
    targetStatus,
    isBorrower,
    isOwner,
  );
  if (transitionError) {
    return c.json(
      { error: transitionError.error },
      transitionError.status as 403 | 422,
    );
  }

  // Update status and timestamp
  borrowRequest.status = targetStatus as BorrowStatus;
  borrowRequest.updatedAt = new Date().toISOString();

  // ONE write: the index carries the record. The pointer is untouched — it
  // holds only `familyId`, which a status change cannot alter. Rewriting the
  // index may evict OLDER terminal records of the SAME borrower past the
  // history cap; the record just updated carries the newest `updatedAt` in that
  // group, so it is never the one evicted.
  await writeBorrowIndex(c.env.KV, familyId, requests);

  return c.json({ data: borrowRequest });
});

interface TransitionError {
  error: ErrorBody["error"];
  status: number;
}

/** Validate a borrow status transition. Returns null if valid, error otherwise. */
function validateStatusTransition(
  currentStatus: BorrowStatus,
  targetStatus: number,
  isBorrower: boolean,
  isOwner: boolean,
): TransitionError | null {
  switch (targetStatus) {
    case BorrowStatus.LENT:
      if (currentStatus !== BorrowStatus.PENDING) {
        return {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "Can only lend from PENDING status",
          },
          status: 422,
        };
      }
      if (!isOwner) {
        return {
          error: {
            code: "FORBIDDEN",
            message: "Only the book owner can approve lending",
          },
          status: 403,
        };
      }
      return null;

    case BorrowStatus.REJECTED:
      if (currentStatus !== BorrowStatus.PENDING) {
        return {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "Can only reject from PENDING status",
          },
          status: 422,
        };
      }
      if (!isOwner) {
        return {
          error: {
            code: "FORBIDDEN",
            message: "Only the book owner can reject a request",
          },
          status: 403,
        };
      }
      return null;

    case BorrowStatus.CANCELLED:
      if (currentStatus !== BorrowStatus.PENDING) {
        return {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "Can only cancel from PENDING status",
          },
          status: 422,
        };
      }
      if (!isBorrower) {
        return {
          error: {
            code: "FORBIDDEN",
            message: "Only the borrower can cancel a request",
          },
          status: 403,
        };
      }
      return null;

    case BorrowStatus.RETURNED:
      if (currentStatus !== BorrowStatus.LENT) {
        return {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "Can only return from LENT status",
          },
          status: 422,
        };
      }
      // Either party can mark as returned
      return null;

    default:
      return {
        error: {
          code: "INVALID_STATUS_TRANSITION",
          message: "Invalid target status",
        },
        status: 422,
      };
  }
}
