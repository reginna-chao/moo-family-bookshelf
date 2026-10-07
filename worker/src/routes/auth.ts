import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { BoolFlag, TOKEN_TTL_SECONDS } from "../kv/schema";
import { getMemberFamilyId } from "../kv/families";
import {
  isValidFamilyId,
  isValidSha256Hex,
  sanitizeVerifySecret,
} from "../utils/validation";
import {
  getOrGenerateAuthToken,
  getAuthenticatedUserId,
} from "../middleware/auth";
import { getCallerIp } from "../middleware/rateLimit";
import {
  isVerificationConfigured,
  validateVerification,
  verificationErrorResponse,
  verifySecretFormatResponse,
} from "../services/verification";
import { readLiveMembers } from "../services/membership";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";

export const authRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// --- Route definitions ---

const lookupRoute = createRoute({
  method: "post",
  path: "/lookup",
  tags: ["Auth"],
  summary: "Look up family membership by userId",
  description:
    "Body: `{ userId: string, verifySecret?: string }`. " +
    "Response data: `{ existingFamilyId: string | null, memberCount: number, " +
    "requiresVerification: 0 | 1 }`. When the account has PWA login " +
    "verification configured and no `verifySecret` is supplied, the endpoint " +
    "answers 200 with `requiresVerification: 1` and NO membership data — the " +
    "client should prompt for the secret and retry. Accounts without " +
    "verification always get `requiresVerification: 0` and the full result. " +
    "A `verifySecret` that is present but malformed (not a string, or longer " +
    "than 256 characters) is rejected with 400 `INVALID_VERIFY_SECRET`, the " +
    "same as on family create/join.",
  responses: {
    200: jsonRes(
      "Family membership lookup result, or a verification-required notice",
    ),
    400: jsonRes("Invalid input"),
    403: jsonRes("Verification failed"),
    429: jsonRes("Verification locked or attempt ceiling reached"),
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["Auth"],
  summary: "Refresh auth token",
  responses: {
    200: jsonRes("New auth token"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized or refresh failed"),
  },
});

// --- Handlers ---

// POST /api/auth/lookup — look up family membership by userId (public, no auth required)
authRoutes.openapi(lookupRoute, async (c) => {
  let body: { userId: string; verifySecret?: unknown } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (
    !body?.userId ||
    typeof body.userId !== "string" ||
    !isValidSha256Hex(body.userId)
  ) {
    return jsonError(
      c,
      400,
      "INVALID_INPUT",
      "userId must be a 64-char hex string",
    );
  }

  const userId = body.userId;
  // Classify the secret at the boundary exactly as create/join do: absent/empty = not supplied,
  // malformed = 400. Rationale: .claude/rules/backend.md → API Design (`verifySecret` bullet).
  const sanitizedSecret = sanitizeVerifySecret(body.verifySecret);
  if (sanitizedSecret === null) {
    return verifySecretFormatResponse(c);
  }
  const verifySecret = sanitizedSecret === "" ? undefined : sanitizedSecret;

  // Verification gate BEFORE any membership read (familyId is the sync code); exactly ONE verify-record
  // read per request. See docs/architecture.md → PWA 登入驗證機制 → 安全措施.
  if (verifySecret === undefined) {
    if (await isVerificationConfigured(c.env.KV, userId)) {
      // Informational, not an error: the client uses this to know it must prompt
      // for the secret and retry. No membership data is revealed.
      return c.json(
        {
          data: {
            existingFamilyId: null,
            memberCount: 0,
            requiresVerification: BoolFlag.TRUE,
          },
        },
        200,
      );
    }
  } else {
    // A supplied secret is a real attempt; consumeOtp: false because create/join resends the SAME
    // secret. See docs/architecture.md → PWA 登入驗證機制 → 安全措施 (OTP bullet).
    const verification = await validateVerification(
      c.env,
      userId,
      verifySecret,
      { callerKey: getCallerIp(c), consumeOtp: false },
    );
    if (!verification.valid) {
      return verificationErrorResponse(c, verification.error);
    }
  }

  // Live membership only (pointer → record that still lists the user, `services/membership.ts`); an
  // orphan or stale pointer answers the no-family shape so the client attempts no reconnect. 2 reads.
  let existingFamilyId: string | null = null;
  let memberCount = 0;

  const familyId = await getMemberFamilyId(c.env.KV, userId);
  if (familyId) {
    const members = await readLiveMembers(c.env.KV, familyId, userId);
    if (members) {
      existingFamilyId = familyId;
      memberCount = members.length;
    }
  }

  return c.json(
    {
      data: {
        existingFamilyId,
        memberCount,
        requiresVerification: BoolFlag.FALSE,
      },
    },
    200,
  );
});

// POST /api/auth/refresh — refresh auth token (protected: requires valid Bearer token)
authRoutes.openapi(refreshRoute, async (c) => {
  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  let body: { userId: string; familyId?: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  // Validate input format
  if (
    !body?.userId ||
    typeof body.userId !== "string" ||
    !isValidSha256Hex(body.userId)
  ) {
    return jsonError(
      c,
      400,
      "INVALID_INPUT",
      "userId must be a 64-char hex string",
    );
  }

  // Ensure the authenticated user matches the requested userId
  if (callerId !== body.userId) {
    return jsonError(c, 401, "REFRESH_FAILED", "Token refresh failed");
  }

  // If familyId is provided, verify membership (backward-compatible path)
  if (body.familyId !== undefined) {
    if (typeof body.familyId !== "string" || !isValidFamilyId(body.familyId)) {
      return jsonError(
        c,
        400,
        "INVALID_INPUT",
        "familyId must match format xxxx-xxxx",
      );
    }
    const storedFamilyId = await getMemberFamilyId(c.env.KV, body.userId);
    if (!storedFamilyId || storedFamilyId !== body.familyId) {
      return jsonError(c, 401, "REFRESH_FAILED", "Token refresh failed");
    }
  }

  const newToken = await getOrGenerateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { token: newToken, expiresAt } }, 200);
});
