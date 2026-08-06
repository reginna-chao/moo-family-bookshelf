import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  TOKEN_TTL_SECONDS,
  type RawFamilyRecord,
  normalizeFamilyRecord,
} from "../kv/schema";
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
} from "./verify";
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
  // Bound and classify the secret at the boundary, exactly as create/join do.
  // An absent/empty secret counts as "not supplied": no attempt was made, so
  // nothing may be charged against the caller's failure budget. A present but
  // malformed value (wrong type, over the length bound) is a request-format
  // error, not a failed verification — 400 here, in all three entry points.
  const sanitizedSecret = sanitizeVerifySecret(body.verifySecret);
  if (sanitizedSecret === null) {
    return verifySecretFormatResponse(c);
  }
  const verifySecret = sanitizedSecret === "" ? undefined : sanitizedSecret;

  // --- Verification gate, BEFORE any membership read ---
  //
  // WHY: familyId is the payload of the sync code, and userId is
  // sha256("moo:" + email) — publicly guessable. Handing familyId to anyone who
  // can guess an email lets a stranger join the victim's not-yet-full family and
  // read the shared shelf. Gating first also means a rejected caller triggers no
  // membership lookup at all. Exactly ONE verify-record read happens per
  // request: either the `isVerificationConfigured` probe below, or the one
  // `validateVerification` performs internally — never both.
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
    // A supplied secret is a real attempt: failures are charged to the CALLER's
    // bucket (never the target account) exactly as in the join flow, and the
    // attempt counts against the target account's global ceiling.
    //
    // consumeOtp: false — lookup is a read-only disclosure decision, and the
    // client's flow is "lookup with the secret, then create/join with the SAME
    // secret". Spending a one-time `code` secret here would make that second
    // call fail with VERIFICATION_FAILED — and be charged as a failure, so five
    // legitimate logins would lock the caller out. The OTP still expires on its
    // own 300s TTL and the caller already holds it, so leaving it intact for one
    // read grants no new capability.
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

  // Look up family membership
  let existingFamilyId: string | null = null;
  let memberCount = 0;

  const familyId = await c.env.KV.get(kvKeys.member(userId));
  if (familyId) {
    existingFamilyId = familyId;
    const raw = await c.env.KV.get<RawFamilyRecord>(
      kvKeys.family(familyId),
      "json",
    );
    if (raw) {
      const record = normalizeFamilyRecord(raw);
      memberCount = record.members.length;
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
    const storedFamilyId = await c.env.KV.get(kvKeys.member(body.userId));
    if (!storedFamilyId || storedFamilyId !== body.familyId) {
      return jsonError(c, 401, "REFRESH_FAILED", "Token refresh failed");
    }
  }

  const newToken = await getOrGenerateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { token: newToken, expiresAt } }, 200);
});
