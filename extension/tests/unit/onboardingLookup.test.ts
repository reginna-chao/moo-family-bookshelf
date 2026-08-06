import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupFamily } from "@/dialog/onboardingLookup";
import { BoolFlag } from "@/api/client";
import type { ApiClient, LookupResult } from "@/api/client";

const USER_ID = "a".repeat(64);

/** ApiClient stub whose lookupUser resolves to a caller-supplied envelope. */
function createMockApiClient(
  lookupUser: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
    data: { existingFamilyId: null, memberCount: 0 },
  }),
): ApiClient {
  return { lookupUser } as unknown as ApiClient;
}

describe("lookupFamily", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The verification gate is expressed INSIDE a 200 body: the server withholds
   * `existingFamilyId` and flags `requiresVerification`. Normalizing that into a
   * failure code is what stops the onboarding flow from telling a user who has a
   * family that they have none.
   */
  describe("requiresVerification normalization", () => {
    it.each([
      [
        "absent (Worker predating the gate)",
        { existingFamilyId: "fam-1", memberCount: 3 } as LookupResult,
        undefined,
      ],
      [
        "absent with no family",
        { existingFamilyId: null, memberCount: 0 } as LookupResult,
        undefined,
      ],
      [
        "explicitly FALSE",
        {
          existingFamilyId: "fam-1",
          memberCount: 2,
          requiresVerification: BoolFlag.FALSE,
        } as LookupResult,
        undefined,
      ],
      [
        "explicitly FALSE while a secret was sent",
        {
          existingFamilyId: "fam-1",
          memberCount: 2,
          requiresVerification: BoolFlag.FALSE,
        } as LookupResult,
        "1234",
      ],
    ])(
      "resolves ok when requiresVerification is %s",
      async (_label, data, verifySecret) => {
        const apiClient = createMockApiClient(
          vi.fn().mockResolvedValue({ data }),
        );

        const outcome = await lookupFamily({
          apiClient,
          userId: USER_ID,
          verifySecret,
        });

        expect(outcome).toEqual({ ok: true, data });
      },
    );

    it("reports VERIFICATION_REQUIRED when the payload is withheld and no secret was sent", async () => {
      const apiClient = createMockApiClient(
        vi.fn().mockResolvedValue({
          data: {
            existingFamilyId: null,
            memberCount: 0,
            requiresVerification: BoolFlag.TRUE,
          },
        }),
      );

      const outcome = await lookupFamily({ apiClient, userId: USER_ID });

      // NOT `{ ok: true, existingFamilyId: null }` — that is the misreading this
      // module exists to prevent.
      expect(outcome).toEqual({
        ok: false,
        errorCode: "VERIFICATION_REQUIRED",
      });
    });

    it("reports VERIFICATION_FAILED when the payload is still withheld after a secret was sent", async () => {
      const apiClient = createMockApiClient(
        vi.fn().mockResolvedValue({
          data: {
            existingFamilyId: null,
            memberCount: 0,
            requiresVerification: BoolFlag.TRUE,
          },
        }),
      );

      const outcome = await lookupFamily({
        apiClient,
        userId: USER_ID,
        verifySecret: "999999",
      });

      expect(outcome).toEqual({ ok: false, errorCode: "VERIFICATION_FAILED" });
    });

    it("treats an empty-string secret as an attempt (FAILED, not REQUIRED)", async () => {
      const apiClient = createMockApiClient(
        vi.fn().mockResolvedValue({
          data: {
            existingFamilyId: null,
            memberCount: 0,
            requiresVerification: BoolFlag.TRUE,
          },
        }),
      );

      const outcome = await lookupFamily({
        apiClient,
        userId: USER_ID,
        verifySecret: "",
      });

      expect(outcome).toEqual({ ok: false, errorCode: "VERIFICATION_FAILED" });
    });

    it("never treats a withheld payload as a truthy family, even if the server also sends a familyId", async () => {
      // Defensive: a buggy/older backend that flags the gate but leaks the id
      // must still go through the prompt rather than silently recovering.
      const apiClient = createMockApiClient(
        vi.fn().mockResolvedValue({
          data: {
            existingFamilyId: "fam-leaked",
            memberCount: 2,
            requiresVerification: BoolFlag.TRUE,
          },
        }),
      );

      const outcome = await lookupFamily({ apiClient, userId: USER_ID });

      expect(outcome.ok).toBe(false);
    });
  });

  describe("error envelopes", () => {
    it.each([
      ["VERIFICATION_FAILED", undefined],
      ["VERIFICATION_LOCKED", 120],
      ["RATE_LIMITED", 45],
      ["SERVER_ERROR", undefined],
    ])(
      "forwards %s (retryAfter %s) from the error envelope",
      async (code, retryAfter) => {
        const apiClient = createMockApiClient(
          vi.fn().mockResolvedValue({
            error: { code, message: "nope", retryAfter },
          }),
        );

        const outcome = await lookupFamily({ apiClient, userId: USER_ID });

        expect(outcome).toEqual({ ok: false, errorCode: code, retryAfter });
      },
    );

    it("reports EMPTY_RESPONSE when the body carries neither data nor error", async () => {
      const apiClient = createMockApiClient(vi.fn().mockResolvedValue({}));

      const outcome = await lookupFamily({ apiClient, userId: USER_ID });

      expect(outcome).toEqual({ ok: false, errorCode: "EMPTY_RESPONSE" });
    });
  });

  describe("request shaping", () => {
    it("omits the options argument entirely when no secret is supplied", async () => {
      const lookupUser = vi.fn().mockResolvedValue({
        data: { existingFamilyId: null, memberCount: 0 },
      });

      await lookupFamily({
        apiClient: createMockApiClient(lookupUser),
        userId: USER_ID,
      });

      expect(lookupUser).toHaveBeenCalledWith(USER_ID, undefined);
    });

    it("passes the secret through to the client when supplied", async () => {
      const lookupUser = vi.fn().mockResolvedValue({
        data: { existingFamilyId: "fam-1", memberCount: 2 },
      });

      await lookupFamily({
        apiClient: createMockApiClient(lookupUser),
        userId: USER_ID,
        verifySecret: "123456",
      });

      expect(lookupUser).toHaveBeenCalledWith(USER_ID, {
        verifySecret: "123456",
      });
    });
  });
});
