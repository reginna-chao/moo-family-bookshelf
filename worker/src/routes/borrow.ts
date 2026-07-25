import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
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
import {
  isValidFamilyId,
  isValidUserId,
  isValidRequestId,
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
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (
    !body?.bookId ||
    !body.bookTitle ||
    !body.bookAuthor ||
    !body.bookCoverUrl ||
    !body.ownerId
  ) {
    return jsonError(
      c,
      400,
      "MISSING_FIELDS",
      "bookId, bookTitle, bookAuthor, bookCoverUrl, and ownerId are required",
    );
  }

  if (
    typeof body.bookId !== "string" ||
    typeof body.bookTitle !== "string" ||
    typeof body.bookAuthor !== "string" ||
    typeof body.bookCoverUrl !== "string" ||
    typeof body.ownerId !== "string"
  ) {
    return jsonError(c, 400, "INVALID_FIELDS", "All fields must be strings");
  }

  if (!isValidUserId(body.ownerId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "ownerId format is invalid");
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
  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );
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

  // Verify ownerId is a different family member
  if (ownerId === userId) {
    return jsonError(c, 403, "INVALID_OWNER", "Cannot borrow your own book");
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

  // Check for duplicate PENDING request (same borrowerId + bookId)
  const indexKey = kvKeys.borrowsByFamily(familyId);
  const existingIndex = await c.env.KV.get<string[]>(indexKey, "json");
  const requestIds = existingIndex ?? [];

  if (requestIds.length > 0) {
    const existingRequests = await Promise.all(
      requestIds.map((id) =>
        c.env.KV.get<BorrowRequest>(kvKeys.borrow(id), "json"),
      ),
    );

    const hasDuplicate = existingRequests.some(
      (req) =>
        req !== null &&
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
  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );
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

  // Load borrow index
  const requestIds = await c.env.KV.get<string[]>(
    kvKeys.borrowsByFamily(familyId),
    "json",
  );
  if (!requestIds || requestIds.length === 0) {
    return c.json({ data: [] });
  }

  // Batch load all borrow records, filter out null (defensive)
  const requests = await Promise.all(
    requestIds.map((id) =>
      c.env.KV.get<BorrowRequest>(kvKeys.borrow(id), "json"),
    ),
  );

  const validRequests = requests.filter((r): r is BorrowRequest => r !== null);

  return c.json({ data: validRequests });
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

  // Load borrow record
  const borrowRequest = await c.env.KV.get<BorrowRequest>(
    kvKeys.borrow(requestId),
    "json",
  );
  if (!borrowRequest) {
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

  await c.env.KV.put(kvKeys.borrow(requestId), JSON.stringify(borrowRequest));

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
