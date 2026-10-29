import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import {
  hashSecret,
  hashSecretWithPepper,
  pepperFingerprint,
} from "../../src/utils/crypto";
import { getVerifyPepper, type Env } from "../../src/utils/env";
import {
  kvKeys,
  VERIFY_HASH_VERSION_PEPPER,
  type VerifyRecord,
} from "../../src/kv/schema";
import {
  upgradeVerifyRecordHash,
  validateVerification,
} from "../../src/services/verification";

/**
 * Server-side pepper for PIN / pattern hashes (verify record v2) — the pure
 * building blocks and the upgrade helper, called directly.
 *
 * `hashSecretWithPepper` is checked against Node's own HMAC implementation (an
 * independent oracle, not the Web Crypto call production makes), and must
 * differ from the v1 `hashSecret` for the same salt + secret. The
 * fingerprint is checked against Node's SHA-256 over `"pepper-id:" + pepper`.
 * `getVerifyPepper` trims, and maps unset / blank to `null` (v1 behaviour).
 *
 * `upgradeVerifyRecordHash` is a no-op unless the record is pin/pattern, v1,
 * has hash + salt, and a pepper is configured; otherwise it rewrites the record
 * with the SAME salt and every other field copied. It is fail-open: a KV error
 * is logged as `VERIFY_HASH_UPGRADE_FAILED` and never thrown.
 *
 * The handler-level wiring (which routes call the upgrade, and when) is in
 * `worker/tests/integration/verifyPepperUpgrade.test.ts`.
 */

const USER_ID = ALICE;
const PEPPER = "server-pepper-0123456789abcdef";
const OTHER_PEPPER = "another-pepper-fedcba9876543210";
const SALT = "ab".repeat(16);
const PIN = "123456";
const SECRET_UPDATED_AT = Date.parse("2026-02-01T00:00:00.000Z");

function nodeHmac(pepper: string, salt: string, secret: string): string {
  return createHmac("sha256", pepper)
    .update(salt + secret)
    .digest("hex");
}

function nodeFingerprint(pepper: string): string {
  return createHash("sha256")
    .update("pepper-id:" + pepper)
    .digest("hex")
    .slice(0, 16);
}

let kv: KVNamespace;

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hashSecretWithPepper", () => {
  it.each([
    { pepper: PEPPER, salt: SALT, secret: PIN },
    { pepper: PEPPER, salt: SALT, secret: "0,1,2,5,8" },
    { pepper: "p", salt: "", secret: "" },
    { pepper: "胡椒-π-🔑", salt: "salt-é", secret: "密碼123" },
  ])(
    "equals Node's HMAC-SHA256(pepper, salt + secret) for $secret",
    async ({ pepper, salt, secret }) => {
      const hash = await hashSecretWithPepper(pepper, salt, secret);

      expect(hash).toBe(nodeHmac(pepper, salt, secret));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("differs from the v1 hashSecret for the same salt and secret", async () => {
    const v2 = await hashSecretWithPepper(PEPPER, SALT, PIN);
    const v1 = await hashSecret(SALT, PIN);

    expect(v2).not.toBe(v1);
    // Positive companion: v1 is the plain SHA-256 the v2 hash must not equal.
    expect(v1).toBe(
      createHash("sha256")
        .update(SALT + PIN)
        .digest("hex"),
    );
  });

  it("changes when the pepper changes", async () => {
    expect(await hashSecretWithPepper(PEPPER, SALT, PIN)).not.toBe(
      await hashSecretWithPepper(OTHER_PEPPER, SALT, PIN),
    );
  });
});

describe("pepperFingerprint", () => {
  it.each([PEPPER, OTHER_PEPPER, "胡椒"])(
    "is the first 16 hex of SHA-256('pepper-id:' + %s)",
    async (pepper) => {
      const id = await pepperFingerprint(pepper);

      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(id).toBe(nodeFingerprint(pepper));
    },
  );

  it("differs between two peppers and is stable for one", async () => {
    const a = await pepperFingerprint(PEPPER);

    expect(await pepperFingerprint(PEPPER)).toBe(a);
    expect(await pepperFingerprint(OTHER_PEPPER)).not.toBe(a);
  });

  it("never equals the pepper's own prefix", async () => {
    expect(await pepperFingerprint(PEPPER)).not.toBe(PEPPER.slice(0, 16));
  });
});

describe("getVerifyPepper", () => {
  it.each([
    { label: "unset", value: undefined, expected: null },
    { label: "empty", value: "", expected: null },
    { label: "spaces only", value: "   ", expected: null },
    { label: "tabs and newlines only", value: "\t\n \r\n", expected: null },
    { label: "a plain value", value: PEPPER, expected: PEPPER },
    { label: "a padded value", value: `  ${PEPPER} \n`, expected: PEPPER },
    { label: "inner spaces", value: " a b ", expected: "a b" },
  ])("returns $expected for $label", ({ value, expected }) => {
    const env = { KV: kv, VERIFY_PEPPER: value } as Env;

    expect(getVerifyPepper(env)).toBe(expected);
  });
});

async function v1Pin(
  overrides: Partial<VerifyRecord> = {},
): Promise<VerifyRecord> {
  return {
    method: "pin",
    hash: await hashSecret(SALT, PIN),
    salt: SALT,
    prompted: 1,
    secretUpdatedAt: SECRET_UPDATED_AT,
    ...overrides,
  };
}

function envWith(pepper: string | undefined): Env {
  return { KV: kv, DEV_MODE: "1", VERIFY_PEPPER: pepper };
}

describe("upgradeVerifyRecordHash", () => {
  it.each([
    { label: "no version", overrides: {} },
    { label: "explicit version 1", overrides: { version: 1 } },
    { label: "a pattern record", overrides: { method: "pattern" as const } },
    { label: "prompted 0", overrides: { prompted: 0 as const } },
    { label: "no secretUpdatedAt", overrides: { secretUpdatedAt: undefined } },
  ])(
    "rewrites a v1 record ($label) as v2 with the same salt and fields",
    async ({ overrides }) => {
      const record = await v1Pin(overrides);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const ops = watchKvOps(kv);

      await upgradeVerifyRecordHash(envWith(PEPPER), USER_ID, record, PIN);

      expect(ops.writeTrail()).toEqual([`put ${kvKeys.verify(USER_ID)}`]);
      const stored = await kv.get<VerifyRecord>(kvKeys.verify(USER_ID), "json");
      expect(stored).toEqual({
        ...JSON.parse(JSON.stringify(record)),
        hash: nodeHmac(PEPPER, SALT, PIN),
        version: VERIFY_HASH_VERSION_PEPPER,
        pepperId: nodeFingerprint(PEPPER),
      });
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("uses the trimmed pepper", async () => {
    await upgradeVerifyRecordHash(
      envWith(`  ${PEPPER}\n`),
      USER_ID,
      await v1Pin(),
      PIN,
    );

    const stored = await kv.get<VerifyRecord>(kvKeys.verify(USER_ID), "json");
    expect(stored?.hash).toBe(nodeHmac(PEPPER, SALT, PIN));
    expect(stored?.pepperId).toBe(nodeFingerprint(PEPPER));
  });

  it.each([
    { label: "a code record", record: { method: "code" as const } },
    { label: "a none record", record: { method: "none" as const } },
    {
      label: "a v2 record",
      record: { version: 2, pepperId: "0".repeat(16) },
    },
    { label: "a version 3 record", record: { version: 3 } },
    { label: "a version 0 record", record: { version: 0 } },
    { label: "a record without hash", record: { hash: null } },
    { label: "a record without salt", record: { salt: null } },
  ])("is a no-op for $label", async ({ record }) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ops = watchKvOps(kv);

    await upgradeVerifyRecordHash(
      envWith(PEPPER),
      USER_ID,
      await v1Pin(record),
      PIN,
    );

    expect(ops.writeTrail()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unset", pepper: undefined },
    { label: "blank", pepper: "  \n" },
  ])("is a no-op when the pepper is $label", async ({ pepper }) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ops = watchKvOps(kv);

    await upgradeVerifyRecordHash(envWith(pepper), USER_ID, await v1Pin(), PIN);

    expect(ops.writeTrail()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("swallows a failing put and logs only the event name", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(kv, "put").mockRejectedValue(
      new Error(`KV put failed for ${kvKeys.verify(USER_ID)}`),
    );

    await expect(
      upgradeVerifyRecordHash(envWith(PEPPER), USER_ID, await v1Pin(), PIN),
    ).resolves.toBeUndefined();

    expect(errors.mock.calls).toEqual([["VERIFY_HASH_UPGRADE_FAILED"]]);
  });
});

describe("validateVerification — hash version", () => {
  async function v2Pin(pepper: string, secret = PIN): Promise<VerifyRecord> {
    return {
      method: "pin",
      hash: await hashSecretWithPepper(pepper, SALT, secret),
      salt: SALT,
      prompted: 1,
      secretUpdatedAt: SECRET_UPDATED_AT,
      version: VERIFY_HASH_VERSION_PEPPER,
      pepperId: await pepperFingerprint(pepper),
    };
  }

  it("admits the correct secret against a v2 record with the matching pepper", async () => {
    const record = await v2Pin(PEPPER);

    const result = await validateVerification(envWith(PEPPER), USER_ID, PIN, {
      callerKey: "203.0.113.1",
      record,
    });

    expect(result).toEqual({ valid: true, record });
  });

  it("refuses a wrong secret against a v2 record as VERIFICATION_FAILED", async () => {
    const result = await validateVerification(
      envWith(PEPPER),
      USER_ID,
      "000000",
      { callerKey: "203.0.113.1", record: await v2Pin(PEPPER) },
    );

    expect(result.valid).toBe(false);
    expect(!result.valid && result.error.code).toBe("VERIFICATION_FAILED");
  });

  it("does not apply the version check to a code record", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const record: VerifyRecord = {
      method: "code",
      hash: null,
      salt: null,
      prompted: 1,
      version: 3,
    };

    const result = await validateVerification(
      envWith(undefined),
      USER_ID,
      undefined,
      { callerKey: "203.0.113.1", record },
    );

    expect(!result.valid && result.error.code).toBe("VERIFICATION_REQUIRED");
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a v2 record with no pepper",
      pepper: undefined,
      record: () => v2Pin(PEPPER),
      event: "VERIFY_PEPPER_MISSING",
    },
    {
      label: "a v2 record without pepperId",
      pepper: PEPPER,
      record: async () => ({ ...(await v2Pin(PEPPER)), pepperId: undefined }),
      event: "VERIFY_PEPPER_MISMATCH",
    },
    {
      label: "a corrupted v2 record (no hash) with no pepper",
      pepper: undefined,
      record: async () => ({ ...(await v2Pin(PEPPER)), hash: null }),
      event: "VERIFY_PEPPER_MISSING",
    },
    {
      label: "a version 0 record",
      pepper: PEPPER,
      record: () => v1Pin({ version: 0 }),
      event: "VERIFY_HASH_VERSION_UNSUPPORTED",
    },
  ])(
    "answers 503 for $label instead of passing it as corrupted",
    async ({ pepper, record, event }) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await validateVerification(envWith(pepper), USER_ID, PIN, {
        callerKey: "203.0.113.1",
        record: (await record()) as VerifyRecord,
      });

      expect(result.valid).toBe(false);
      expect(!result.valid && result.error).toEqual({
        code: "VERIFY_UNAVAILABLE",
        message: "伺服器的驗證設定不完整，請聯絡管理者",
        status: 503,
      });
      expect(errors.mock.calls).toEqual([[event]]);
    },
  );
});
