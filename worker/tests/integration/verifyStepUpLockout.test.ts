import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import { ALICE } from "../helpers/ids";
import { kvKeys, VERIFY_MAX_FAILURES } from "../../src/kv/schema";

/**
 * One lockout for every place a PIN is typed (#396).
 *
 * The step-up on `PUT /api/user/:id/verify` and `DELETE /api/user/:id` charges
 * a wrong `currentSecret` to the SAME caller-scoped streak as PWA login,
 * `verifyfail:{userId}:{callerIp}` — a separate prefix would hand a token
 * holder extra guesses. So `VERIFY_MAX_FAILURES` wrong guesses from one
 * address, spread over any mix of PUT, DELETE and the login gate
 * (`POST /api/auth/lookup`), lock all three with `429 VERIFICATION_LOCKED`
 * (and a `retryAfter`), even for the correct secret. Another address keeps
 * its own budget.
 *
 * Requests run without DEV_MODE, with the binding stubs (which admit every
 * per-IP charge, so the sensitive tier's 3/min never interferes); the PIN is
 * set through the real route under DEV_MODE.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const PIN = "123456";
const WRONG_PIN = "000000";
const LOCKED_IP = "203.0.113.30";
const OTHER_IP = "203.0.113.31";

type Entry = "put" | "delete" | "login";

async function send(
  method: string,
  path: string,
  body: unknown,
  opts: { token?: string; ip: string; dev?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": opts.ip,
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const env = opts.dev
    ? { KV: kv, DEV_MODE: "1" }
    : { KV: kv, ...rateLimitBindings() };
  return app.request(
    path,
    { method, headers, body: JSON.stringify(body) },
    env,
  );
}

/** One attempt with `secret` through `entry`, from `ip`. */
function attempt(
  entry: Entry,
  token: string,
  secret: string,
  ip: string,
): Promise<Response> {
  if (entry === "put") {
    return send(
      "PUT",
      `/api/user/${USER_ID}/verify`,
      { method: "none", currentSecret: secret },
      { token, ip },
    );
  }
  if (entry === "delete") {
    return send(
      "DELETE",
      `/api/user/${USER_ID}`,
      { currentSecret: secret },
      { token, ip },
    );
  }
  return send(
    "POST",
    "/api/auth/lookup",
    { userId: USER_ID, verifySecret: secret },
    { ip },
  );
}

async function setPin(): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await send(
    "PUT",
    `/api/user/${USER_ID}/verify`,
    { method: "pin", secret: PIN },
    { token: seeded, ip: OTHER_IP, dev: true },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

async function expectLocked(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  const { error } = (await res.json()) as Json;
  expect(error.code).toBe("VERIFICATION_LOCKED");
  expect(error.retryAfter).toBeGreaterThan(0);
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-01-01T00:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("step-up lockout shared with PWA login", () => {
  it.each<{ label: string; guesses: Entry[] }>([
    {
      label: "wrong guesses on PUT alone",
      guesses: Array(VERIFY_MAX_FAILURES).fill("put"),
    },
    {
      label: "wrong guesses on DELETE alone",
      guesses: Array(VERIFY_MAX_FAILURES).fill("delete"),
    },
    {
      label: "wrong guesses at the login gate alone",
      guesses: Array(VERIFY_MAX_FAILURES).fill("login"),
    },
    {
      label: "a mix of PUT, DELETE and login",
      guesses: ["put", "delete", "login", "put", "delete"],
    },
  ])("locks PUT, DELETE and login alike after $label", async ({ guesses }) => {
    expect(guesses).toHaveLength(VERIFY_MAX_FAILURES);
    const token = await setPin();

    for (const entry of guesses) {
      const res = await attempt(entry, token, WRONG_PIN, LOCKED_IP);
      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe(
        "VERIFICATION_FAILED",
      );
    }

    // The correct PIN no longer helps from this address, on any of the three.
    for (const entry of ["put", "delete", "login"] as const) {
      await expectLocked(await attempt(entry, token, PIN, LOCKED_IP));
    }
    // One shared key, no per-endpoint prefix.
    const failKeys = (await kv.list()).keys
      .map((k) => k.name)
      .filter((name) => name.startsWith(kvKeys.verifyFail(USER_ID, "")));
    expect(failKeys).toEqual([kvKeys.verifyFail(USER_ID, LOCKED_IP)]);
    // Nothing was changed or deleted while locked.
    expect(await kv.get(kvKeys.verify(USER_ID))).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER_ID);
  });

  it("leaves another address its own budget", async () => {
    const token = await setPin();
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      await attempt("put", token, WRONG_PIN, LOCKED_IP);
    }

    const res = await attempt("put", token, PIN, OTHER_IP);

    expect(res.status).toBe(200);
  });
});
