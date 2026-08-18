import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { ALICE, BOB, CHARLIE, DAVE } from "../helpers/ids";
import { seedAuthToken as seedAuthTokenPair, tokenFor } from "../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  type FamilyRecord,
  type RawFamilyRecord,
} from "../../src/kv/schema";
import {
  peekPerUserRateLimit,
  type PerUserRateLimitOptions,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { FAMILY_WRITE_LIMIT } from "../../src/routes/family";
import { VERIFY_WRITE_LIMIT } from "../../src/routes/verify";

// ===========================================================================
// Per-userId write ceiling on the family-domain write handlers
//
// The five AUTHENTICATED write handlers — DELETE /api/family/:id/member/:uid,
// PUT /api/family/:id/member/:uid/displayName, PATCH /api/family/:id/member/:uid,
// PUT /api/family/:id/transfer and PUT /api/family/:id/endpoint — share ONE
// per-userId counter, so a single account cannot drain the Worker's daily KV
// write quota by rotating source addresses. The public onboarding routes
// (POST /api/family, POST /api/family/:id/join) and the read-only
// GET /api/family/:id/members are deliberately NOT on this ceiling.
//
// Two properties this suite exists to pin, beyond the raw limit:
// - the counter is charged to the AUTHENTICATED CALLER, never to the `:uid`
//   path param — a counter keyed on someone else's id would be a victim-facing
//   DoS lever (the defect that got join's standalone per-userId counter
//   removed);
// - every rejection that happens BEFORE the charge site (401 / 403 / malformed
//   uid 400) leaves the account's budget untouched, and keeps answering with the
//   same status once the window is spent, so a 429 never leaks the existence or
//   state of an account to a caller who is not it.
//
// Everything here runs WITHOUT DEV_MODE, which the other family suites set:
// DEV_MODE short-circuits `enforcePerUserRateLimit`, so the ceiling would never
// fire. Setup that must not spend the live budget goes through the DEV_MODE
// helper (`devRequest`) on purpose.
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/** Family owner — the account whose write budget is under test. */
const OWNER_ID = ALICE;
/** An ordinary member of the same family. */
const MEMBER_ID = BOB;
/** A third member, present so `DELETE member` has a removable target. */
const EXTRA_ID = CHARLIE;
/** Someone with no family at all — used for the create / join cases. */
const OUTSIDER_ID = DAVE;

const FAMILY_ID = "abcd-1234";

const OWNER_TOKEN = tokenFor(OWNER_ID);
const MEMBER_TOKEN = tokenFor(MEMBER_ID);
const EXTRA_TOKEN = tokenFor(EXTRA_ID);

/**
 * The very options object the five `enforcePerUserRateLimit` call sites in
 * `src/routes/family.ts` spread, imported rather than copied — so the boundary
 * cases below (last write admitted, next one refused) track any change to the
 * ceiling instead of silently drifting from it. The counter KEY is likewise
 * always derived through the production key builder (`peekPerUserRateLimit`).
 */
const {
  scope: WRITE_SCOPE,
  max: WRITE_MAX,
  windowSec: WRITE_WINDOW_SECONDS,
} = FAMILY_WRITE_LIMIT;

const WRITE_WINDOW_MS = WRITE_WINDOW_SECONDS * 1000;

/**
 * Exactly mid-window, so the counter cannot roll over mid-test AND the back-off
 * hint is deterministic. Derived from the production window length rather than
 * hard-coded, so a changed window keeps the pin exact.
 */
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WRITE_WINDOW_MS) *
    WRITE_WINDOW_MS +
  WRITE_WINDOW_MS / 2;

/** Back-off the mid-window pin must produce: half the window, rounded up. */
const EXPECTED_RETRY_AFTER = Math.ceil(WRITE_WINDOW_SECONDS / 2);

// --- Requests ------------------------------------------------------------

interface RequestOptions {
  /** JSON-serialized into the body; omit to send no body at all. */
  body?: unknown;
  /** Sent as `Authorization: Bearer …`; omit to send no credentials at all. */
  token?: string;
  /** Sent as `cf-connecting-ip` — the only caller identity the Worker trusts. */
  callerIp?: string;
}

async function buildRequest(
  method: string,
  path: string,
  opts: RequestOptions,
  env: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.callerIp) headers["cf-connecting-ip"] = opts.callerIp;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return app.request(path, init, env);
}

/** Live request: no DEV_MODE, so both limiters run. */
function prodRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  return buildRequest(method, path, opts, { KV: kv });
}

/** DEV_MODE request: every limiter short-circuits — for setup only. */
function devRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  return buildRequest(method, path, opts, { KV: kv, DEV_MODE: "1" });
}

// --- Seeding -------------------------------------------------------------

/**
 * The family every test starts from: OWNER + MEMBER + EXTRA, with one free seat
 * so the "join is not on this ceiling" case has capacity.
 *
 * Written straight to KV rather than through create/join, because those two
 * routes are exactly the ones this change leaves OUT of the ceiling — driving
 * setup through them would blur what the assertions prove. The record is typed
 * as the production `FamilyRecord` and keyed through `kvKeys`, so a schema or
 * key change breaks compilation here instead of seeding a dead key.
 */
async function seedFamily(): Promise<void> {
  const record: FamilyRecord = {
    familyId: FAMILY_ID,
    ownerId: OWNER_ID,
    members: [
      { userId: OWNER_ID, displayName: "Owner", canLend: BoolFlag.TRUE },
      { userId: MEMBER_ID, displayName: "Member", canLend: BoolFlag.TRUE },
      { userId: EXTRA_ID, displayName: "Extra", canLend: BoolFlag.TRUE },
    ],
    maxMembers: 4,
    createdAt: new Date().toISOString(),
  };
  await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(record));
  await Promise.all([
    kv.put(kvKeys.member(OWNER_ID), FAMILY_ID),
    kv.put(kvKeys.member(MEMBER_ID), FAMILY_ID),
    kv.put(kvKeys.member(EXTRA_ID), FAMILY_ID),
    seedAuthTokenPair(kv, OWNER_ID),
    seedAuthTokenPair(kv, MEMBER_ID),
    seedAuthTokenPair(kv, EXTRA_ID),
  ]);
}

/** The stored family record, as the handlers would read it back. */
async function storedFamily(): Promise<RawFamilyRecord | null> {
  return kv.get<RawFamilyRecord>(kvKeys.family(FAMILY_ID), "json");
}

// --- Counter inspection --------------------------------------------------

/** A per-userId ceiling minus the account it applies to. */
type CeilingSpec = Omit<PerUserRateLimitOptions, "userId">;

/** Counter key of the user's CURRENT window for `spec`, via the production builder. */
async function counterKey(userId: string, spec: CeilingSpec): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, { userId, ...spec });
  return reading.key;
}

const writeCounterKey = (userId: string) =>
  counterKey(userId, FAMILY_WRITE_LIMIT);

const verifyWriteCounterKey = (userId: string) =>
  counterKey(userId, VERIFY_WRITE_LIMIT);

/**
 * The scope-carrying prefix of a counter key, cut at the userId it embeds —
 * derived from a production-built key rather than spelled out here, so the key
 * shape stays owned by `peekPerUserRateLimit` alone.
 */
function counterPrefix(key: string, userId: string): string {
  return key.slice(0, key.indexOf(userId));
}

async function countAt(key: string): Promise<number | null> {
  const raw = await kv.get(key);
  return raw === null ? null : parseInt(raw, 10);
}

/** Family-domain writes charged to the account so far, or null if never charged. */
async function writesCharged(userId: string): Promise<number | null> {
  return countAt(await writeCounterKey(userId));
}

/** Verify-domain writes charged to the account, or null if never charged. */
async function verifyWritesCharged(userId: string): Promise<number | null> {
  return countAt(await verifyWriteCounterKey(userId));
}

/** Every key currently in KV that starts with `prefix`. */
async function keysWithPrefix(prefix: string): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((k) => k.name).filter((name) => name.startsWith(prefix));
}

/** Every family-write counter key currently in KV, whatever the userId. */
async function writeCounterKeys(): Promise<string[]> {
  const prefix = counterPrefix(await writeCounterKey(OWNER_ID), OWNER_ID);
  return keysWithPrefix(prefix);
}

/** Pre-spend `used` slots of a ceiling — far cheaper than driving 30 requests. */
async function spendBudget(
  userId: string,
  spec: CeilingSpec,
  used: number,
): Promise<void> {
  await kv.put(await counterKey(userId, spec), String(used), {
    expirationTtl: spec.windowSec * 2,
  });
}

const spendWriteBudget = (userId: string, used: number) =>
  spendBudget(userId, FAMILY_WRITE_LIMIT, used);

const spendVerifyWriteBudget = (userId: string, used: number) =>
  spendBudget(userId, VERIFY_WRITE_LIMIT, used);

// --- Endpoint table ------------------------------------------------------

interface EndpointCall {
  label: string;
  /** `token` is always explicit — omitting it means "send no credentials". */
  call: (token?: string) => Promise<Response>;
}

interface WriteEndpoint extends EndpointCall {
  /**
   * The same route and body, addressed with a MALFORMED `:id`. Built from the
   * one path template `call` uses, so the two can never drift into exercising
   * different handlers.
   */
  callWithMalformedFamilyId: (token?: string) => Promise<Response>;
}

/** Fails `^[a-z0-9]{4}-[a-z0-9]{4}$`, which every handler checks first. */
const MALFORMED_FAMILY_ID = "not-a-family-id";

/** Fails the strict 64-hex userId rule (`^[a-f0-9]{64}$`). */
const MALFORMED_USER_ID = "not-a-valid-user-id";

function writeEndpoint(
  label: string,
  method: string,
  path: (familyId: string) => string,
  body?: unknown,
): WriteEndpoint {
  return {
    label,
    call: (token) => prodRequest(method, path(FAMILY_ID), { body, token }),
    callWithMalformedFamilyId: (token) =>
      prodRequest(method, path(MALFORMED_FAMILY_ID), { body, token }),
  };
}

/**
 * The five authenticated write endpoints that share the ceiling, each shaped so
 * the OWNER's call is admitted against the seeded family. Driving all of them
 * from one table is what proves the limit is a property of the SCOPE, not of a
 * single handler.
 */
const WRITE_ENDPOINTS: WriteEndpoint[] = [
  writeEndpoint(
    "DELETE member",
    "DELETE",
    (familyId) => `/api/family/${familyId}/member/${EXTRA_ID}`,
  ),
  writeEndpoint(
    "PUT displayName",
    "PUT",
    (familyId) => `/api/family/${familyId}/member/${OWNER_ID}/displayName`,
    { displayName: "Renamed" },
  ),
  writeEndpoint(
    "PATCH member settings",
    "PATCH",
    (familyId) => `/api/family/${familyId}/member/${MEMBER_ID}`,
    { readmooName: "Member RM" },
  ),
  writeEndpoint(
    "PUT transfer",
    "PUT",
    (familyId) => `/api/family/${familyId}/transfer`,
    { newOwnerId: MEMBER_ID },
  ),
  writeEndpoint(
    "PUT endpoint",
    "PUT",
    (familyId) => `/api/family/${familyId}/endpoint`,
    { apiEndpoint: "https://api.example.com" },
  ),
];

/**
 * The THREE handlers that carry a `:uid` path param — the two remaining write
 * endpoints (transfer, endpoint) address no member at all. Each entry is the
 * endpoint's normal call with only the target id replaced by a malformed one,
 * so the sole difference under test is the format rejection.
 */
const MALFORMED_UID_ENDPOINTS: EndpointCall[] = [
  {
    label: "DELETE member",
    call: (token) =>
      prodRequest(
        "DELETE",
        `/api/family/${FAMILY_ID}/member/${MALFORMED_USER_ID}`,
        { token },
      ),
  },
  {
    label: "PUT displayName",
    call: (token) =>
      prodRequest(
        "PUT",
        `/api/family/${FAMILY_ID}/member/${MALFORMED_USER_ID}/displayName`,
        { body: { displayName: "Renamed" }, token },
      ),
  },
  {
    label: "PATCH member settings",
    call: (token) =>
      prodRequest(
        "PATCH",
        `/api/family/${FAMILY_ID}/member/${MALFORMED_USER_ID}`,
        { body: { readmooName: "Member RM" }, token },
      ),
  },
];

/**
 * One cheap, repeatable write — used wherever the endpoint is arbitrary.
 * Renaming yourself needs no ownership and mutates nothing another case
 * depends on.
 */
function renameSelf(token?: string, name = "Renamed"): Promise<Response> {
  return prodRequest(
    "PUT",
    `/api/family/${FAMILY_ID}/member/${OWNER_ID}/displayName`,
    { body: { displayName: name }, token },
  );
}

/** The same cheap write, performed by MEMBER on their own display name. */
function memberRenamesSelf(token?: string): Promise<Response> {
  return prodRequest(
    "PUT",
    `/api/family/${FAMILY_ID}/member/${MEMBER_ID}/displayName`,
    { body: { displayName: "Member 2" }, token },
  );
}

beforeEach(async () => {
  kv = createMockKV();
  // Pin Date (timers stay real) so the 1-hour window cannot roll over between
  // seeding the counter and the request under test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  await seedFamily();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Family-domain per-userId write ceiling", () => {
  it.each(WRITE_ENDPOINTS)(
    "charges exactly one slot for $label and keeps the counter self-expiring",
    async ({ call }) => {
      const res = await call(OWNER_TOKEN);

      expect(res.status).toBe(200);
      expect(await writesCharged(OWNER_ID)).toBe(1);
      // Without a TTL the counter would live in KV forever.
      expect(getPutTtl(kv, await writeCounterKey(OWNER_ID))).toBe(
        WRITE_WINDOW_SECONDS * 2,
      );
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "refuses $label with 429 once the shared window is spent",
    async ({ call }) => {
      await spendWriteBudget(OWNER_ID, WRITE_MAX);

      const res = await call(OWNER_TOKEN);

      expect(res.status).toBe(429);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
      // The pinned clock sits exactly mid-window, so the back-off hint is half
      // the window — which also pins the window length end to end.
      expect(Number.isInteger(json.error.retryAfter)).toBe(true);
      expect(json.error.retryAfter).toBe(EXPECTED_RETRY_AFTER);
      expect(json.error.retryAfter).toBeGreaterThan(0);
      expect(res.headers.get("Retry-After")).toBe(
        String(json.error.retryAfter),
      );
      // A refused write must not extend the window.
      expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    },
  );

  it("admits exactly WRITE_MAX real requests in a window and refuses the next", async () => {
    // The one case that seeds NOTHING: it drives the counter entirely through
    // the HTTP path, so the pre-spent-counter shortcut every other case uses
    // cannot become a self-fulfilling prophecy. Well under the per-IP standard
    // tier (60/min), which would otherwise refuse these first.
    for (let i = 0; i < WRITE_MAX; i++) {
      const res = await renameSelf(OWNER_TOKEN, `Name ${i}`);
      expect(res.status).toBe(200);
    }

    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    expect(await writeCounterKeys()).toHaveLength(1);

    const overCeiling = await renameSelf(OWNER_TOKEN);
    expect(overCeiling.status).toBe(429);
    expect(((await overCeiling.json()) as Json).error.code).toBe(
      "RATE_LIMITED",
    );
  });

  it("counts remove-member, displayName, settings, transfer and endpoint against ONE shared window", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX - WRITE_ENDPOINTS.length);

    // Ordered so no case destroys a later one's preconditions: the owner keeps
    // ownership (and their token) until the transfer, which goes last but one.
    const rename = await renameSelf(OWNER_TOKEN);
    expect(rename.status).toBe(200);

    const settings = await prodRequest(
      "PATCH",
      `/api/family/${FAMILY_ID}/member/${MEMBER_ID}`,
      { body: { readmooName: "Member RM" }, token: OWNER_TOKEN },
    );
    expect(settings.status).toBe(200);

    const endpoint = await prodRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/endpoint`,
      { body: { apiEndpoint: "https://api.example.com" }, token: OWNER_TOKEN },
    );
    expect(endpoint.status).toBe(200);

    const removal = await prodRequest(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${EXTRA_ID}`,
      { token: OWNER_TOKEN },
    );
    expect(removal.status).toBe(200);

    const transfer = await prodRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/transfer`,
      { body: { newOwnerId: MEMBER_ID }, token: OWNER_TOKEN },
    );
    expect(transfer.status).toBe(200);

    // Five different handlers, one counter.
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    expect(await writeCounterKeys()).toHaveLength(1);

    // The next write is legal on every count except the shared window — which
    // is exactly what the scope enforces.
    const refused = await renameSelf(OWNER_TOKEN);
    expect(refused.status).toBe(429);
  });

  it("admits the last write the window has room for and refuses the next handler", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX - 1);

    const lastAllowed = await renameSelf(OWNER_TOKEN);
    expect(lastAllowed.status).toBe(200);
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);

    // A DIFFERENT handler, the same exhausted window.
    const overCeiling = await prodRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/endpoint`,
      { body: { apiEndpoint: "https://api.example.com" }, token: OWNER_TOKEN },
    );
    expect(overCeiling.status).toBe(429);
    expect(((await overCeiling.json()) as Json).error.code).toBe(
      "RATE_LIMITED",
    );
  });

  it("charges the shared window even when the handler then rejects the request", async () => {
    // MEMBER is not the owner, so transfer refuses them — but the ceiling sits
    // above that check on purpose: charging BEFORE the handler's body parse and
    // permission checks is what stops a rejected-request loop from retrying for
    // free. Moving the ceiling below them must fail here.
    const res = await prodRequest("PUT", `/api/family/${FAMILY_ID}/transfer`, {
      body: { newOwnerId: EXTRA_ID },
      token: MEMBER_TOKEN,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("NOT_OWNER");
    // The request did no work at all — ownership is untouched...
    expect((await storedFamily())?.ownerId).toBe(OWNER_ID);
    // ...and it still cost the caller a slot.
    expect(await writesCharged(MEMBER_ID)).toBe(1);
  });

  it("does not extend the window when a refused caller keeps retrying", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    for (let i = 0; i < 3; i++) {
      const res = await renameSelf(OWNER_TOKEN);
      expect(res.status).toBe(429);
    }

    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
  });

  it("performs no family-domain KV write at all while the window is spent", async () => {
    const recordBefore = await kv.get(kvKeys.family(FAMILY_ID));
    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    for (const { call } of WRITE_ENDPOINTS) {
      const res = await call(OWNER_TOKEN);
      expect(res.status).toBe(429);
    }

    // Byte-identical family record, and the member DELETE would have torn down
    // both of the removed member's keys — neither happened.
    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBe(recordBefore);
    expect(await kv.get(kvKeys.member(EXTRA_ID))).toBe(FAMILY_ID);
    expect(await kv.get(kvKeys.authToken(EXTRA_TOKEN))).toBe(EXTRA_ID);
  });

  it("counts each caller independently", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    const blocked = await renameSelf(OWNER_TOKEN);
    expect(blocked.status).toBe(429);

    const allowed = await memberRenamesSelf(MEMBER_TOKEN);
    expect(allowed.status).toBe(200);
    expect(await writesCharged(MEMBER_ID)).toBe(1);
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
  });

  it("does not apply the write ceiling in dev mode", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    // Same request through the DEV_MODE helper — local wrangler dev and E2E
    // runs must not be throttled.
    const res = await devRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/member/${OWNER_ID}/displayName`,
      { body: { displayName: "Renamed" }, token: OWNER_TOKEN },
    );

    expect(res.status).toBe(200);
    // Dev mode neither reads nor charges the counter.
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
  });
});

// ===========================================================================
// The counter follows the CALLER, not the target
//
// Every one of these handlers takes a `:uid` (or a `newOwnerId`) that is some
// OTHER account. Charging the ceiling to that id instead of to the
// authenticated caller would hand an owner — or anyone who can reach the
// route — a lever to exhaust a member's own write budget. This is the exact
// defect that got the join endpoint's standalone per-userId counter removed.
// ===========================================================================

describe("Family-domain write ceiling — the caller pays, never the target", () => {
  it("spends only the owner's budget when the owner writes against a member's uid", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX - 2);

    for (const name of ["RM one", "RM two"]) {
      const res = await prodRequest(
        "PATCH",
        `/api/family/${FAMILY_ID}/member/${MEMBER_ID}`,
        { body: { readmooName: name }, token: OWNER_TOKEN },
      );
      expect(res.status).toBe(200);
    }

    // The owner burned their own window down to the ceiling...
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    const ownerBlocked = await prodRequest(
      "PATCH",
      `/api/family/${FAMILY_ID}/member/${MEMBER_ID}`,
      { body: { readmooName: "RM three" }, token: OWNER_TOKEN },
    );
    expect(ownerBlocked.status).toBe(429);

    // ...while the member they targeted was never charged a thing, and their
    // own writes still go through with a full budget.
    expect(await writesCharged(MEMBER_ID)).toBeNull();
    const victimWrite = await memberRenamesSelf(MEMBER_TOKEN);
    expect(victimWrite.status).toBe(200);
    expect(await writesCharged(MEMBER_ID)).toBe(1);
  });

  it("spends only the owner's budget when the owner transfers ownership to a member", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX - 1);

    const res = await prodRequest("PUT", `/api/family/${FAMILY_ID}/transfer`, {
      body: { newOwnerId: MEMBER_ID },
      token: OWNER_TOKEN,
    });

    expect(res.status).toBe(200);
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    // The new owner inherits the family, not a spent window.
    expect(await writesCharged(MEMBER_ID)).toBeNull();
    const newOwnerWrite = await prodRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/endpoint`,
      { body: { apiEndpoint: "https://api.example.com" }, token: MEMBER_TOKEN },
    );
    expect(newOwnerWrite.status).toBe(200);
    expect(await writesCharged(MEMBER_ID)).toBe(1);
  });
});

// ===========================================================================
// Rejections that happen BEFORE the charge site
//
// The charge sits after every zero-I/O guard, uniformly across the five
// handlers — the placement rule itself is documented at the first charge site
// (`src/routes/family.ts`, the DELETE member handler). Concretely, before a
// slot can be spent: all five reject a malformed `:id` (400 INVALID_FAMILY_ID)
// and an unauthenticated caller (401); the three that take a `:uid` — DELETE
// member, displayName, PATCH member settings — also reject a malformed target
// id (400 INVALID_USER_ID); and displayName additionally answers its pure
// self-only 403.
//
// A caller refused at any of those must be able neither to SPEND the account's
// write budget nor to OBSERVE it: a 429 where a 401 / 403 / 400 belongs would
// confirm the account exists and is active.
// ===========================================================================

describe("Family-domain write ceiling — rejections that must not charge", () => {
  it.each(WRITE_ENDPOINTS)(
    "answers $label with 401 without charging any account",
    async ({ call }) => {
      const res = await call();

      expect(res.status).toBe(401);
      expect(await writesCharged(OWNER_ID)).toBeNull();
      expect(await writeCounterKeys()).toHaveLength(0);
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "still answers $label with 401 rather than 429 once the window is spent",
    async ({ call }) => {
      await spendWriteBudget(OWNER_ID, WRITE_MAX);

      // A stranger learns nothing about the account's budget...
      const res = await call();

      expect(res.status).toBe(401);
      // ...and spends none of it.
      expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    },
  );

  it("does not charge a displayName write aimed at another member (403)", async () => {
    const res = await prodRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/member/${MEMBER_ID}/displayName`,
      { body: { displayName: "Hijacked" }, token: OWNER_TOKEN },
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("FORBIDDEN");
    expect(await writeCounterKeys()).toHaveLength(0);

    // The refused attempt left the full budget available: the next legitimate
    // write is the FIRST charge of the window.
    const own = await renameSelf(OWNER_TOKEN);
    expect(own.status).toBe(200);
    expect(await writesCharged(OWNER_ID)).toBe(1);
  });

  it("still answers a foreign displayName write with 403 rather than 429 once the window is spent", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    const res = await prodRequest(
      "PUT",
      `/api/family/${FAMILY_ID}/member/${MEMBER_ID}/displayName`,
      { body: { displayName: "Hijacked" }, token: OWNER_TOKEN },
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("FORBIDDEN");
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
  });

  it.each(MALFORMED_UID_ENDPOINTS)(
    "answers $label with 400 for a malformed target id without charging",
    async ({ call }) => {
      const res = await call(OWNER_TOKEN);

      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).error.code).toBe("INVALID_USER_ID");
      expect(await writeCounterKeys()).toHaveLength(0);
    },
  );

  it.each(MALFORMED_UID_ENDPOINTS)(
    "still answers $label with 400 rather than 429 for a malformed target id once the window is spent",
    async ({ call }) => {
      await spendWriteBudget(OWNER_ID, WRITE_MAX);

      const res = await call(OWNER_TOKEN);

      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).error.code).toBe("INVALID_USER_ID");
      expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "answers $label with 400 for a malformed family id without charging",
    async ({ callWithMalformedFamilyId }) => {
      const res = await callWithMalformedFamilyId(OWNER_TOKEN);

      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).error.code).toBe("INVALID_FAMILY_ID");
      expect(await writeCounterKeys()).toHaveLength(0);
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "still answers $label with 400 rather than 429 for a malformed family id once the window is spent",
    async ({ callWithMalformedFamilyId }) => {
      await spendWriteBudget(OWNER_ID, WRITE_MAX);

      const res = await callWithMalformedFamilyId(OWNER_TOKEN);

      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).error.code).toBe("INVALID_FAMILY_ID");
      expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
    },
  );
});

// ===========================================================================
// Family routes deliberately left OUT of the ceiling
//
// Onboarding (create / join) is public and already bounded by the sensitive
// per-IP tier plus the verification gate's charge-on-failure attempt ceiling;
// putting it on a per-userId write counter would let a spent window lock a user
// out of forming a family at all. The members list is a read.
// ===========================================================================

describe("Family-domain write ceiling — routes outside it", () => {
  it("serves GET members with the window spent and charges no counter", async () => {
    const path = `/api/family/${FAMILY_ID}/members`;

    const beforeSpend = await prodRequest("GET", path, { token: OWNER_TOKEN });
    expect(beforeSpend.status).toBe(200);
    // A read must not create a write counter at all.
    expect(await writeCounterKeys()).toHaveLength(0);

    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    const afterSpend = await prodRequest("GET", path, { token: OWNER_TOKEN });
    expect(afterSpend.status).toBe(200);
    const json = (await afterSpend.json()) as Json;
    expect(json.data.familyId).toBe(FAMILY_ID);
    // Reading charged nothing to the spent window either.
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
  });

  it("still lets an account with a spent window CREATE a family", async () => {
    await spendWriteBudget(OUTSIDER_ID, WRITE_MAX);

    const res = await prodRequest("POST", "/api/family", {
      body: { userId: OUTSIDER_ID, displayName: "Newcomer" },
    });

    expect(res.status).toBe(201);
    // Create is not on this ceiling: it neither reads nor charges the counter.
    expect(await writesCharged(OUTSIDER_ID)).toBe(WRITE_MAX);
  });

  it("still lets an account with a spent window JOIN a family", async () => {
    await spendWriteBudget(OUTSIDER_ID, WRITE_MAX);

    const res = await prodRequest("POST", `/api/family/${FAMILY_ID}/join`, {
      body: { userId: OUTSIDER_ID, displayName: "Newcomer" },
    });

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.member(OUTSIDER_ID))).toBe(FAMILY_ID);
    expect(await writesCharged(OUTSIDER_ID)).toBe(WRITE_MAX);
  });
});

// ===========================================================================
// Cross-scope isolation
//
// "family-write" is deliberately its own scope, distinct from the verify-domain
// write ceiling ("verify-write", same 30/hr shape in `routes/verify.ts`).
// Sharing one counter would let a burst of family administration lock the owner
// out of their PWA verification settings, and vice versa — both directions are
// covered below.
// ===========================================================================

describe("Family-domain write ceiling — isolation from the verify-write ceiling", () => {
  it("keys the two ceilings under prefixes that cannot alias each other", async () => {
    expect(WRITE_SCOPE).not.toBe(VERIFY_WRITE_LIMIT.scope);

    const familyKey = await writeCounterKey(OWNER_ID);
    const verifyKey = await verifyWriteCounterKey(OWNER_ID);
    expect(familyKey).not.toBe(verifyKey);

    // Same userId and same window length, so the scope segment is the ONLY
    // thing keeping the two counters apart — and neither prefix may be a prefix
    // of the other, or a `startsWith` scan would sweep up both.
    const familyPrefix = counterPrefix(familyKey, OWNER_ID);
    const verifyPrefix = counterPrefix(verifyKey, OWNER_ID);
    expect(familyPrefix.startsWith(verifyPrefix)).toBe(false);
    expect(verifyPrefix.startsWith(familyPrefix)).toBe(false);
  });

  it("leaves the verify-write budget intact when the family window is spent", async () => {
    await spendWriteBudget(OWNER_ID, WRITE_MAX);

    const res = await prodRequest(
      "POST",
      `/api/user/${OWNER_ID}/verify/prompted`,
      { body: {}, token: OWNER_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(await verifyWritesCharged(OWNER_ID)).toBe(1);
    expect(await writesCharged(OWNER_ID)).toBe(WRITE_MAX);
  });

  it("leaves the family-write budget intact when the verify-write window is spent", async () => {
    await spendVerifyWriteBudget(OWNER_ID, VERIFY_WRITE_LIMIT.max);

    const blocked = await prodRequest(
      "POST",
      `/api/user/${OWNER_ID}/verify/prompted`,
      { body: {}, token: OWNER_TOKEN },
    );
    expect(blocked.status).toBe(429);

    const familyWrite = await renameSelf(OWNER_TOKEN);
    expect(familyWrite.status).toBe(200);
    expect(await writesCharged(OWNER_ID)).toBe(1);
    expect(await verifyWritesCharged(OWNER_ID)).toBe(VERIFY_WRITE_LIMIT.max);
  });
});
