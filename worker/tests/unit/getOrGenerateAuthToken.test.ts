import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { createMockKV } from "../helpers/mockKv";
import { getOrGenerateAuthToken } from "../../src/middleware/auth";
import {
  kvKeys,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
} from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

const HEX64 = /^[a-f0-9]{64}$/;
const EXISTING_TOKEN = "a".repeat(64);
const STALE_TOKEN = "b".repeat(64);
const ORIGINAL_CREATED_AT = "2026-01-01T00:00:00.000Z";

let kv: KVNamespace;
let putSpy: MockInstance<KVNamespace["put"]>;

beforeEach(() => {
  kv = createMockKV();
  // Spy AFTER kv is built; by default vi.spyOn keeps the real implementation,
  // so writes still land in the in-memory store while we capture the options.
  putSpy = vi.spyOn(kv, "put");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Return the `expirationTtl` options recorded for every put to `key`. */
function ttlsPutFor(key: string): (number | undefined)[] {
  return putSpy.mock.calls
    .filter(([k]) => k === key)
    .map(
      ([, , opts]) =>
        (opts as KVNamespacePutOptions | undefined)?.expirationTtl,
    );
}

async function seedValidToken(userId: string, token: string) {
  const record: AuthRecord = { token, createdAt: ORIGINAL_CREATED_AT };
  await kv.put(kvKeys.auth(userId), JSON.stringify(record));
  await kv.put(kvKeys.authToken(token), userId);
}

describe("getOrGenerateAuthToken", () => {
  describe("valid token hit (sliding TTL)", () => {
    it("should return the same token and re-put both KV entries with a fresh 90d TTL", async () => {
      await seedValidToken(USER1, EXISTING_TOKEN);
      putSpy.mockClear(); // ignore the seed writes above

      const token = await getOrGenerateAuthToken(kv, USER1);

      // Same token string is returned — no churn.
      expect(token).toBe(EXISTING_TOKEN);

      // Both directions were re-put with the shared 90d TTL.
      expect(ttlsPutFor(kvKeys.auth(USER1))).toContain(TOKEN_TTL_SECONDS);
      expect(ttlsPutFor(kvKeys.authToken(EXISTING_TOKEN))).toContain(
        TOKEN_TTL_SECONDS,
      );
    });

    it("should preserve the original token and createdAt when sliding the TTL", async () => {
      await seedValidToken(USER1, EXISTING_TOKEN);

      await getOrGenerateAuthToken(kv, USER1);

      const stored = (await kv.get(kvKeys.auth(USER1), "json")) as AuthRecord;
      expect(stored.token).toBe(EXISTING_TOKEN);
      expect(stored.createdAt).toBe(ORIGINAL_CREATED_AT);

      // Reverse lookup still resolves to the same user.
      expect(await kv.get(kvKeys.authToken(EXISTING_TOKEN))).toBe(USER1);
    });
  });

  describe("dead / mismatched reverse lookup (does not resurrect stale token)", () => {
    interface Scenario {
      name: string;
      seed: () => Promise<void>;
    }

    const scenarios: Scenario[] = [
      {
        name: "reverse lookup entry is missing (KV TTL expired it)",
        seed: async () => {
          // Only the forward auth record survives; token:{stale} is gone.
          const record: AuthRecord = {
            token: STALE_TOKEN,
            createdAt: ORIGINAL_CREATED_AT,
          };
          await kv.put(kvKeys.auth(USER1), JSON.stringify(record));
        },
      },
      {
        name: "reverse lookup points to a different user",
        seed: async () => {
          const record: AuthRecord = {
            token: STALE_TOKEN,
            createdAt: ORIGINAL_CREATED_AT,
          };
          await kv.put(kvKeys.auth(USER1), JSON.stringify(record));
          await kv.put(kvKeys.authToken(STALE_TOKEN), USER2); // wrong owner
        },
      },
    ];

    scenarios.forEach(({ name, seed }) => {
      it(`should mint a fresh token when ${name}`, async () => {
        await seed();

        const token = await getOrGenerateAuthToken(kv, USER1);

        // A brand new token is minted, never the stale one.
        expect(token).toMatch(HEX64);
        expect(token).not.toBe(STALE_TOKEN);

        // Forward record now points at the new token with the fresh createdAt.
        const stored = (await kv.get(kvKeys.auth(USER1), "json")) as AuthRecord;
        expect(stored.token).toBe(token);
        expect(stored.createdAt).not.toBe(ORIGINAL_CREATED_AT);

        // New reverse lookup resolves; both entries carry the 90d TTL.
        expect(await kv.get(kvKeys.authToken(token))).toBe(USER1);
        expect(ttlsPutFor(kvKeys.auth(USER1))).toContain(TOKEN_TTL_SECONDS);
        expect(ttlsPutFor(kvKeys.authToken(token))).toContain(
          TOKEN_TTL_SECONDS,
        );
      });
    });
  });

  describe("no existing record", () => {
    it("should mint a fresh token and write both directions with a 90d TTL", async () => {
      const token = await getOrGenerateAuthToken(kv, USER1);

      expect(token).toMatch(HEX64);
      expect(await kv.get(kvKeys.authToken(token))).toBe(USER1);

      const stored = (await kv.get(kvKeys.auth(USER1), "json")) as AuthRecord;
      expect(stored.token).toBe(token);
      expect(stored.createdAt).toEqual(expect.any(String));

      expect(ttlsPutFor(kvKeys.auth(USER1))).toContain(TOKEN_TTL_SECONDS);
      expect(ttlsPutFor(kvKeys.authToken(token))).toContain(TOKEN_TTL_SECONDS);
    });
  });
});
