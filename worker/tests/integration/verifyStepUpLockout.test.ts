import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import { ALICE } from "../helpers/ids";
import { BoolFlag, kvKeys, VERIFY_MAX_FAILURES } from "../../src/kv/schema";
import { DERIVED_STEP_UP_BUCKET } from "../../src/services/authRecord";
import { VERIFY_ATTEMPT_WINDOW_SECONDS } from "../../src/services/verification";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * The step-up's lockout belongs to the token that presents the secret.
 *
 * A wrong `currentSecret` on `PUT /api/user/:id/verify` or `DELETE /api/user/:id`
 * charges `verifyfail:{userId}:{callerIp}:{bucket}`, where the bucket is the
 * token's list hash when it is unmarked and the one shared `derived` otherwise.
 * `VERIFY_MAX_FAILURES` wrong guesses from one address, over any mix of PUT and
 * DELETE, lock both for that token with `429 VERIFICATION_LOCKED` (and a
 * `retryAfter`), even for the correct secret.
 *
 * What stays open from that same address: another unmarked token, and the login
 * gate (`POST /api/auth/lookup`), whose streak is `verifyfail:{userId}:{callerIp}`.
 * Login's lockout does not reach the step-up either.
 *
 * Another address keeps its own streak for the same token. `VERIFY_MAX_FAILURES`
 * equals the hourly step-up budget, so the wrong guesses that lock an address also
 * spend the token's budget for the hour. That case therefore locks in the last
 * seconds of a window and asks in the first seconds of the next, where the 15-minute
 * lock still stands and the budget is fresh.
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
const SECOND_TOKEN = "e".repeat(64);
const WINDOW_MS = VERIFY_ATTEMPT_WINDOW_SECONDS * 1000;
const PINNED_NOW = Date.parse("2026-01-01T00:30:00.000Z");

type StepUpEntry = "put" | "delete";

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

/** One step-up attempt with `secret` through `entry`, from `ip`. */
function stepUp(
  entry: StepUpEntry,
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
  return send(
    "DELETE",
    `/api/user/${USER_ID}`,
    { currentSecret: secret },
    { token, ip },
  );
}

function login(secret: string, ip: string): Promise<Response> {
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

async function expectCode(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(((await res.json()) as Json).error.code).toBe(code);
}

async function expectLocked(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  const { error } = (await res.json()) as Json;
  expect(error.code).toBe("VERIFICATION_LOCKED");
  expect(error.retryAfter).toBeGreaterThan(0);
}

async function lockFrom(ip: string, token: string): Promise<void> {
  for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
    await expectCode(
      await stepUp("put", token, WRONG_PIN, ip),
      403,
      "VERIFICATION_FAILED",
    );
  }
}

async function failKeys(): Promise<string[]> {
  const prefix = kvKeys.verifyFail(USER_ID, "");
  return (await kv.list({ prefix })).keys.map((key) => key.name);
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("step-up lockout — one token", () => {
  it.each<{ label: string; guesses: StepUpEntry[] }>([
    {
      label: "wrong guesses on PUT alone",
      guesses: Array<StepUpEntry>(VERIFY_MAX_FAILURES).fill("put"),
    },
    {
      label: "wrong guesses on DELETE alone",
      guesses: Array<StepUpEntry>(VERIFY_MAX_FAILURES).fill("delete"),
    },
    {
      label: "a mix of PUT and DELETE",
      guesses: ["put", "delete", "put", "delete", "put"],
    },
  ])("locks PUT and DELETE alike after $label", async ({ guesses }) => {
    expect(guesses).toHaveLength(VERIFY_MAX_FAILURES);
    const token = await setPin();

    for (const entry of guesses) {
      await expectCode(
        await stepUp(entry, token, WRONG_PIN, LOCKED_IP),
        403,
        "VERIFICATION_FAILED",
      );
    }

    // The correct PIN no longer helps this token from this address, on either route.
    for (const entry of ["put", "delete"] as const) {
      await expectLocked(await stepUp(entry, token, PIN, LOCKED_IP));
    }
    // One key for this token at this address, none for login.
    const bucket = await hashAuthToken(token);
    expect(await failKeys()).toEqual([
      kvKeys.verifyFail(USER_ID, `${LOCKED_IP}:${bucket}`),
    ]);
    // Nothing was changed or deleted while locked.
    expect(await kv.get(kvKeys.verify(USER_ID))).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER_ID);
  });
});

describe("step-up lockout — the same address", () => {
  it("leaves another unmarked token open", async () => {
    const token = await setPin();
    const second = await seedAuthToken(kv, USER_ID, {
      token: SECOND_TOKEN,
      appendTo: true,
    });
    await lockFrom(LOCKED_IP, token);
    await expectLocked(await stepUp("put", token, PIN, LOCKED_IP));

    const res = await stepUp("put", second, PIN, LOCKED_IP);

    expect(res.status).toBe(200);
  });

  it("locks every token on the shared derived budget together", async () => {
    const token = await setPin();
    const marked = await seedAuthToken(kv, USER_ID, {
      token: SECOND_TOKEN,
      appendTo: true,
      derived: BoolFlag.TRUE,
    });
    const otherMarked = await seedAuthToken(kv, USER_ID, {
      token: "f".repeat(64),
      appendTo: true,
      derived: BoolFlag.TRUE,
    });
    await lockFrom(LOCKED_IP, marked);

    await expectLocked(await stepUp("put", otherMarked, PIN, LOCKED_IP));

    expect(await failKeys()).toEqual([
      kvKeys.verifyFail(USER_ID, `${LOCKED_IP}:${DERIVED_STEP_UP_BUCKET}`),
    ]);
    expect((await stepUp("put", token, PIN, LOCKED_IP)).status).toBe(200);
  });

  it("leaves the login gate open after a token locks", async () => {
    const token = await setPin();
    await lockFrom(LOCKED_IP, token);

    const res = await login(PIN, LOCKED_IP);

    expect(res.status).toBe(200);
    expect(await failKeys()).not.toContain(
      kvKeys.verifyFail(USER_ID, LOCKED_IP),
    );
  });

  it("leaves the step-up open after the login gate locks", async () => {
    const token = await setPin();
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      await expectCode(
        await login(WRONG_PIN, LOCKED_IP),
        403,
        "VERIFICATION_FAILED",
      );
    }
    await expectLocked(await login(PIN, LOCKED_IP));

    const res = await stepUp("put", token, PIN, LOCKED_IP);

    expect(res.status).toBe(200);
  });
});

describe("step-up lockout — another address", () => {
  it("keeps its own streak for the same token", async () => {
    const token = await setPin();
    const nextWindowStart =
      Math.ceil(PINNED_NOW / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
    vi.setSystemTime(nextWindowStart - 10_000);
    await lockFrom(LOCKED_IP, token);
    vi.setSystemTime(nextWindowStart + 10_000);

    await expectLocked(await stepUp("put", token, PIN, LOCKED_IP));
    await expectCode(
      await stepUp("put", token, WRONG_PIN, OTHER_IP),
      403,
      "VERIFICATION_FAILED",
    );
    expect((await stepUp("put", token, PIN, OTHER_IP)).status).toBe(200);
  });

  it("meets the token's spent budget, not the lockout, inside the same hour", async () => {
    const token = await setPin();
    await lockFrom(LOCKED_IP, token);

    await expectCode(
      await stepUp("put", token, PIN, OTHER_IP),
      429,
      "RATE_LIMITED",
    );
  });
});
