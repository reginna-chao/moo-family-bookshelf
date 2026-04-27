import { Hono } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  BorrowStatus,
  type BorrowRequest,
  type FamilyMember,
  type RawFamilyRecord,
  normalizeFamilyRecord,
  hasMember,
  findMember,
} from "../kv/schema";
import { isValidFamilyId, isValidUserId, isValidRequestId } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";

export const borrowRoutes = new Hono<{ Bindings: Env }>();

/** Check if a member has lending enabled (treat missing/undefined as TRUE for backward compat). */
function isMemberLendingEnabled(member: FamilyMember): boolean {
  return member.canLend !== BoolFlag.FALSE;
}

// POST /api/family/:id/borrow — create borrow request
borrowRoutes.post("/family/:id/borrow", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  let body: {
    bookId?: string;
    bookTitle?: string;
    bookAuthor?: string;
    bookCoverUrl?: string;
    ownerId?: string;
  } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (
    !body?.bookId ||
    !body.bookTitle ||
    !body.bookAuthor ||
    !body.bookCoverUrl ||
    !body.ownerId
  ) {
    return c.json(
      { error: { code: "MISSING_FIELDS", message: "bookId, bookTitle, bookAuthor, bookCoverUrl, and ownerId are required" } },
      400,
    );
  }

  if (typeof body.bookId !== "string" || typeof body.bookTitle !== "string" ||
      typeof body.bookAuthor !== "string" || typeof body.bookCoverUrl !== "string" ||
      typeof body.ownerId !== "string") {
    return c.json(
      { error: { code: "INVALID_FIELDS", message: "All fields must be strings" } },
      400,
    );
  }

  if (!isValidUserId(body.ownerId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "ownerId format is invalid" } },
      400,
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
  const raw = await c.env.KV.get<RawFamilyRecord>(kvKeys.family(familyId), "json");
  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const family = normalizeFamilyRecord(raw);

  // Verify caller is a family member
  if (!hasMember(family.members, userId)) {
    return c.json(
      { error: { code: "NOT_FAMILY_MEMBER", message: "You are not a member of this family" } },
      403,
    );
  }

  // Verify ownerId is a different family member
  if (ownerId === userId) {
    return c.json(
      { error: { code: "INVALID_OWNER", message: "Cannot borrow your own book" } },
      403,
    );
  }

  if (!hasMember(family.members, ownerId)) {
    return c.json(
      { error: { code: "INVALID_OWNER", message: "Owner is not a member of this family" } },
      403,
    );
  }

  // Check canLend for both parties
  const borrowerMember = findMember(family.members, userId);
  const ownerMember = findMember(family.members, ownerId);
  if (!borrowerMember || !ownerMember) {
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Member lookup failed" } },
      500,
    );
  }

  if (!isMemberLendingEnabled(borrowerMember) || !isMemberLendingEnabled(ownerMember)) {
    return c.json(
      { error: { code: "LENDING_DISABLED", message: "Lending is disabled for one or both members" } },
      403,
    );
  }

  // Check for duplicate PENDING request (same borrowerId + bookId)
  const indexKey = kvKeys.borrowsByFamily(familyId);
  const existingIndex = await c.env.KV.get<string[]>(indexKey, "json");
  const requestIds = existingIndex ?? [];

  if (requestIds.length > 0) {
    const existingRequests = await Promise.all(
      requestIds.map((id) => c.env.KV.get<BorrowRequest>(kvKeys.borrow(id), "json")),
    );

    const hasDuplicate = existingRequests.some(
      (req) =>
        req !== null &&
        req.borrowerId === userId &&
        req.bookId === bookId &&
        req.status === BorrowStatus.PENDING,
    );

    if (hasDuplicate) {
      return c.json(
        { error: { code: "DUPLICATE_REQUEST", message: "A pending borrow request already exists for this book" } },
        400,
      );
    }
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
    bookCoverUrl: body.bookCoverUrl,
    status: BorrowStatus.PENDING,
    createdAt: now,
    updatedAt: now,
  };

  // Write borrow record and update index
  const updatedIndex = [...requestIds, requestId];

  // NOTE: No atomic CAS in KV. Concurrent POSTs from two members can both
  // read the same index and the second put overwrites the first, dropping
  // the earlier requestId. Acceptable for 2-person families with low
  // concurrency. Borrow record at borrow:{requestId} is still written, but
  // becomes invisible to GET /family/:id/borrow until the index is rebuilt.
  // For strict correctness, scope index per-borrower or use Durable Objects.
  await Promise.all([
    c.env.KV.put(kvKeys.borrow(requestId), JSON.stringify(borrowRequest)),
    c.env.KV.put(indexKey, JSON.stringify(updatedIndex)),
  ]);

  return c.json({ data: borrowRequest }, 201);
});

// GET /api/family/:id/borrow — list family borrow requests
borrowRoutes.get("/family/:id/borrow", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    scope: "borrow-list",
    max: 60,
    windowSec: 60,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // Verify caller is a family member
  const raw = await c.env.KV.get<RawFamilyRecord>(kvKeys.family(familyId), "json");
  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const family = normalizeFamilyRecord(raw);
  if (!hasMember(family.members, userId)) {
    return c.json(
      { error: { code: "NOT_FAMILY_MEMBER", message: "You are not a member of this family" } },
      403,
    );
  }

  // Load borrow index
  const requestIds = await c.env.KV.get<string[]>(kvKeys.borrowsByFamily(familyId), "json");
  if (!requestIds || requestIds.length === 0) {
    return c.json({ data: [] });
  }

  // Batch load all borrow records, filter out null (defensive)
  const requests = await Promise.all(
    requestIds.map((id) => c.env.KV.get<BorrowRequest>(kvKeys.borrow(id), "json")),
  );

  const validRequests = requests.filter((r): r is BorrowRequest => r !== null);

  return c.json({ data: validRequests });
});

// PATCH /api/borrow/:requestId — update borrow status
borrowRoutes.patch("/borrow/:requestId", async (c) => {
  const requestId = c.req.param("requestId");

  if (!isValidRequestId(requestId)) {
    return c.json(
      { error: { code: "INVALID_REQUEST_ID", message: "Request ID format is invalid" } },
      400,
    );
  }

  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  let body: { status?: number } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (body?.status === undefined || body.status === null) {
    return c.json(
      { error: { code: "MISSING_FIELDS", message: "status is required" } },
      400,
    );
  }

  if (typeof body.status !== "number" || !Number.isInteger(body.status)) {
    return c.json(
      { error: { code: "INVALID_FIELDS", message: "status must be an integer" } },
      400,
    );
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

  // Load borrow record
  const borrowRequest = await c.env.KV.get<BorrowRequest>(kvKeys.borrow(requestId), "json");
  if (!borrowRequest) {
    return c.json(
      { error: { code: "REQUEST_NOT_FOUND", message: "Borrow request not found" } },
      404,
    );
  }

  // Validate caller is either borrower or owner
  const isBorrower = userId === borrowRequest.borrowerId;
  const isOwner = userId === borrowRequest.ownerId;

  if (!isBorrower && !isOwner) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "You are not authorized to update this request" } },
      403,
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

  await c.env.KV.put(kvKeys.borrow(requestId), JSON.stringify(borrowRequest));

  return c.json({ data: borrowRequest });
});

interface TransitionError {
  error: { code: string; message: string };
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
          error: { code: "INVALID_STATUS_TRANSITION", message: "Can only lend from PENDING status" },
          status: 422,
        };
      }
      if (!isOwner) {
        return {
          error: { code: "FORBIDDEN", message: "Only the book owner can approve lending" },
          status: 403,
        };
      }
      return null;

    case BorrowStatus.REJECTED:
      if (currentStatus !== BorrowStatus.PENDING) {
        return {
          error: { code: "INVALID_STATUS_TRANSITION", message: "Can only reject from PENDING status" },
          status: 422,
        };
      }
      if (!isOwner) {
        return {
          error: { code: "FORBIDDEN", message: "Only the book owner can reject a request" },
          status: 403,
        };
      }
      return null;

    case BorrowStatus.CANCELLED:
      if (currentStatus !== BorrowStatus.PENDING) {
        return {
          error: { code: "INVALID_STATUS_TRANSITION", message: "Can only cancel from PENDING status" },
          status: 422,
        };
      }
      if (!isBorrower) {
        return {
          error: { code: "FORBIDDEN", message: "Only the borrower can cancel a request" },
          status: 403,
        };
      }
      return null;

    case BorrowStatus.RETURNED:
      if (currentStatus !== BorrowStatus.LENT) {
        return {
          error: { code: "INVALID_STATUS_TRANSITION", message: "Can only return from LENT status" },
          status: 422,
        };
      }
      // Either party can mark as returned
      return null;

    default:
      return {
        error: { code: "INVALID_STATUS_TRANSITION", message: "Invalid target status" },
        status: 422,
      };
  }
}
