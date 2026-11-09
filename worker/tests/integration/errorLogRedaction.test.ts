import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { kvKeys, type VerifyRecord } from "../../src/kv/schema";
import { hashSecret } from "../../src/utils/crypto";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { ALICE } from "../helpers/ids";

/**
 * A KV error whose message names the key never reaches the Worker log (#480).
 *
 * Production KV errors read `KV <op> failed: <status> <statusText>`; workerd's
 * own text carries no key, but the statusText comes from the KV backend, and
 * whether it can carry the key is unverified — this suite assumes the worst.
 * The KV store is `createMockKV()` behind a wrapper (`failGetsMatching`) whose
 * `get` throws such a message, with the FULL key in it, for the keys a
 * predicate picks and passes every other call straight through to the mock.
 *
 * The request is the public login gate, `POST /api/auth/lookup`, in two shapes:
 * - no `verifySecret`: the handler's first KV read is `verify:{userId}`;
 * - a PIN account with the right PIN and a `CF-Connecting-IP`: the gate reads
 *   `verify:{userId}` and then the caller's `verifyfail:{userId}:{ip}` — the
 *   key that embeds BOTH the userId and the caller IP.
 *
 * Either throw escapes to the root `app.onError`. Asserted per case: the
 * response is still `500 INTERNAL_ERROR`; `console.error` fired exactly once,
 * as `"Unhandled error:"` with `{ err: { name, kvOp, kvStatus }, method,
 * route }` (the positive companion); and the whole call, serialized with every
 * Error's `message` and `stack` expanded, holds neither the key, the userId
 * nor the IP.
 *
 * Production mode (no `DEV_MODE`) with the Rate Limiting binding stubs
 * spread into env, as in every deploy: without them the per-IP middleware
 * would log `RATE_LIMIT_BINDING_MISSING` and "exactly once" would go red for a
 * reason unrelated to this suite.
 */

const USER_ID = ALICE;
const CALLER_IP = "203.0.113.77";
const PIN = "123456";
const SALT = "ab".repeat(16);

let kv: KVNamespace;

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `kv` whose `get` throws a workerd-shaped message naming the key for matching keys.
 *  See the header. */
function failGetsMatching(
  base: KVNamespace,
  matches: (key: string) => boolean,
): KVNamespace {
  const get = base.get.bind(base) as (
    key: string,
    ...rest: unknown[]
  ) => Promise<unknown>;
  return {
    ...base,
    get: async (key: string, ...rest: unknown[]): Promise<unknown> => {
      if (matches(key)) {
        throw new Error(`KV GET failed: 503 Service Unavailable ${key}`);
      }
      return get(key, ...rest);
    },
  } as unknown as KVNamespace;
}

function lookup(store: KVNamespace, body: Record<string, unknown>) {
  return app.request(
    "/api/auth/lookup",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": CALLER_IP,
      },
      body: JSON.stringify(body),
    },
    { KV: store, ...rateLimitBindings() },
  );
}

/** One console call as JSON, with every Error's `message` and `stack` expanded. */
function serializeLogCall(call: unknown[]): string {
  return JSON.stringify(call, (_key, value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

async function expectRedactedUnhandledLog(
  res: Response,
  errorLog: { mock: { calls: unknown[][] } },
  secrets: string[],
): Promise<void> {
  expect(res.status).toBe(500);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "INTERNAL_ERROR",
  );
  expect(errorLog.mock.calls).toHaveLength(1);
  const [call] = errorLog.mock.calls;
  expect(call[0]).toBe("Unhandled error:");
  const logged = serializeLogCall(call);
  for (const secret of secrets) expect(logged).not.toContain(secret);
  expect(call.slice(1)).toEqual([
    {
      err: { name: "Error", kvOp: "GET", kvStatus: 503 },
      method: "POST",
      route: "/api/auth/lookup",
    },
  ]);
}

describe("Unhandled KV error on POST /api/auth/lookup", () => {
  it("logs no key or userId when the verify: read throws", async () => {
    const failingKey = kvKeys.verify(USER_ID);
    const store = failGetsMatching(kv, (key) => key === failingKey);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await lookup(store, { userId: USER_ID });

    await expectRedactedUnhandledLog(res, errorLog, [failingKey, USER_ID]);
  });

  it("logs no key, userId or caller IP when the gate's verifyfail: read throws", async () => {
    const record: VerifyRecord = {
      method: "pin",
      hash: await hashSecret(SALT, PIN),
      salt: SALT,
      prompted: 1,
    };
    await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
    const failPrefix = kvKeys.verifyFail(USER_ID, "");
    const seen: string[] = [];
    const store = failGetsMatching(kv, (key) => {
      seen.push(key);
      return key.startsWith(failPrefix);
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await lookup(store, { userId: USER_ID, verifySecret: PIN });

    // Positive companion: the throw hit the caller-keyed key, IP included.
    const failingKey = kvKeys.verifyFail(USER_ID, CALLER_IP);
    expect(seen).toContain(failingKey);
    await expectRedactedUnhandledLog(res, errorLog, [
      failingKey,
      USER_ID,
      CALLER_IP,
    ]);
  });
});
