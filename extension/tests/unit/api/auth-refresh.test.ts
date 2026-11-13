import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import browser from "webextension-polyfill";
import {
  clearFamilyStorage,
  doRefreshToken,
  isFamilyGoneError,
} from "@/api/auth-refresh";
import { BoolFlag, type ApiResponse } from "@/api/types";
import { beginSelfDeparture } from "@/storage/selfDeparture";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  TOKEN_SERVER_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  STORE_PAGE_INDEX_KEY,
} from "@/constants";
import { validateEndpointUrl } from "@/api/client";

/**
 * doRefreshToken branching contract (security-ux Invariant 2 — a dead token must
 * NEVER silently drop the user's family data). Returns a `RefreshOutcome`
 * ({ refreshed, rateLimited?, cooldownUntil? }), not a bare boolean:
 *
 *  - refresh succeeds            → store the new token, { refreshed: true },
 *    clear any recovery cooldown.
 *  - refresh fails, join recovers → store the recovered token, { refreshed: true },
 *    clear any recovery cooldown.
 *  - recovery rate-limited (fresh 429) → write a recovery cooldown, return
 *    { refreshed: false, rateLimited: true, cooldownUntil }; do NOT prompt
 *    verification and do NOT clear family data.
 *  - recovery cooldown still active → skip the join entirely, same rate-limited
 *    outcome.
 *  - recovery blocked by a verification code → call onReauthRequired, KEEP data.
 *  - recovery says family is gone (FAMILY_NOT_FOUND / FAMILY_FULL /
 *    MEMBER_REMOVED / RECOVERY_NOT_MEMBER) → clear (family id + the
 *    family-scoped API endpoint) and hand the triggering code to
 *    onFamilyRemoved.
 *  - the user's own leave / account deletion is in flight (#263) → the refresh
 *    POST still runs, but the silent join is skipped and nothing is cleared.
 *  - any other / transient failure → leave family data intact for a later retry.
 *
 * doRefreshToken takes an injected `deps` boundary (request / setAuthToken /
 * callbacks) so this is a pure unit test of the branching — only browser.storage
 * (via the shared setup mock) and the injected request are stubbed.
 *
 * Storage seeding (`seedStorage`): writes go into the shared store-backed mock
 * from `tests/setup.ts`, so every read and every write in a test hits ONE store:
 * what doRefreshToken sets or removes is what the next read sees. Stubbing `get`
 * with a frozen snapshot instead would keep answering the pre-call world,
 * silently defusing any test that calls doRefreshToken twice (the auto-rejoin
 * test: the second call must see the world the first call left behind — the
 * removal of familyId is what has to stop the rejoin). The seeding calls are
 * then wiped from the spies so the assertion helpers only ever observe calls
 * PRODUCTION made. The store is module-scoped, so `afterEach` clears it before
 * restoring the mocks, while the store-backed implementations are still installed.
 *
 * Family-scoped endpoint: every test seeds `SEEDED_ENDPOINT` (the family's
 * self-hosted API endpoint this device had accepted) so EVERY branch's effect on
 * the family-scoped endpoint keys is observable — the gone branch must drop
 * them, and no other branch may. The API endpoint is FAMILY-scoped (the owner
 * picks it, every member adopts it), so it lives and dies with the membership,
 * and being REMOVED ends the membership exactly like leaving does:
 *  - a client left pointed at the ex-family's server would send the NEXT
 *    create/join there — userId, display name, the token that server issues and
 *    the whole personal book list — and bake that host into the sync code it
 *    then hands out;
 *  - the declined marker goes for the same reason: a refusal recorded against
 *    the old family must not silently suppress the confirmation prompt for the
 *    next one;
 *  - every retryable branch keeps it: an over-eager reset would send the user's
 *    next request — and the retry that is still expected to succeed — to a
 *    different server. The verification branch keeps it because the user is
 *    about to re-supply their secret and that join has to reach the SAME
 *    server; the rate-limit branch keeps it because the client still needs to
 *    reach the right server once the window clears.
 * `endpointChoiceWasReset()` checks BOTH keys (the accepted endpoint and the
 * declined marker) — the family-scoped endpoint keys (`FAMILY_ENDPOINT_CHOICE_KEYS`).
 * Folding them into the shared teardown's (`clearFamilyStorage`) single removal
 * is what structurally guarantees the silent path and the re-verification path
 * do it identically.
 *
 * MEMBER_REMOVED (owner-initiated removal): the worker writes a
 * `kicked:{familyId}:{userId}` tombstone when an owner removes another member,
 * so the recovery join is answered with 403 MEMBER_REMOVED for as long as it
 * lives. Treating that as family-gone is the whole point of the code: otherwise
 * silent recovery keeps re-joining and, once the tombstone expires, quietly
 * undoes the removal.
 *
 * onReauthRequired payload: the verification branch reports WHAT blocked
 * recovery, so the dialog can open the prompt in the right state (locked +
 * countdown vs. plain challenge).
 *
 * Recovery cooldown clamp: the requested wait is clamped to 1 hour
 * (MAX_RECOVERY_COOLDOWN_SECONDS in `src/api/recoveryCooldown.ts`) and any
 * non-positive/absent value falls back to 300s, so a hostile or buggy
 * self-hosted (BYO) backend cannot suppress auto-recovery effectively forever.
 * The persisted deadline is clamped on READ as well as on write: a value written
 * before the write-side cap existed (or inflated by clock skew) must not outlive
 * the 1h maximum. The clamped value is also what gets returned, so the UI
 * countdown driven by `cooldownUntil` can never show more than the maximum either.
 * The read clamp is PERSISTED back (#293): clamping only the returned value would
 * re-clamp a far-future deadline against a fresh `now` on every read, so a legacy
 * 10-day deadline kept auto-recovery suppressed for the full 10 days. Re-saving it
 * at the 1h max lets the cooldown actually expire 1h later (PWA twin:
 * `pwa/src/utils/recoveryCooldown.ts`).
 *
 * Reauth-pending latch (skip guard): a verification prompt raised by an earlier
 * 401 wave sets `isReauthPending() === true`. On the dialog's second data wave
 * the refresh POST still runs, but silent join-recovery must be suppressed —
 * otherwise it would re-spend the per-IP join budget and re-fire
 * onReauthRequired, wiping the user's in-progress pattern/PIN input.
 *
 * Recovery join body: the silent join is flagged `recovery: 1` (#263) so the
 * server can refuse a user no longer listed in the family instead of re-adding
 * them, and it still omits displayName so the member's chosen name is kept.
 *
 * Own departure in flight (#263): the server can revoke the user's token before
 * it answers their own "leave family" / "delete account" request, so another
 * request 401s while the departure is in flight. A silent join then would re-add
 * the user to the family they are leaving, so it is skipped while the departure
 * mark is up — but the refresh POST still runs (a token fixed elsewhere recovers
 * without a join) and nothing is torn down.
 *
 * Issued credentials (#350): the refresh `token` and the recovery join's
 * `authToken` are kept only when they are a 64-char lowercase hex string, and
 * `expiresAt` only when it is a finite number above 0
 * (`shared/src/api/issuedCredentials.ts`). A token in any other shape takes
 * EXACTLY the path a missing token takes — on refresh, the failure branch and
 * staged recovery; on the recovery join, `recovered: false` with no error code,
 * i.e. the transient branch that keeps family data. A bad expiry is simply not
 * stored while the token itself still is. Every fixture token is therefore in
 * the issued shape (`FRESH_TOKEN` / `RECOVERED_TOKEN` / `UNUSED_TOKEN`), so a
 * guard case's join, were it to fire, would recover and fail the assertions.
 *
 * isFamilyGoneError: the SINGLE definition of "the join target is gone for this
 * user". The underlying code set is exported READ-ONLY for one consumer — the
 * copy-coverage tripwire in `tests/unit/dialog/familyGoneNotice.test.ts` — and
 * is never membership-tested at runtime, so the dialog's re-verification flow
 * (`dialog/useVerificationPrompt.ts`, reached from `dialog/useReauth.ts`)
 * classifies through this predicate rather than keeping a second copy — the
 * drift a second copy invites is what the export prevents. The distinction it
 * draws is load-bearing: a family-gone code means NO secret can make the join
 * succeed (stop retrying, drop the local family binding), while a verification /
 * rate-limit code means the opposite (keep the data, let the user try again —
 * security-ux Invariant 2).
 *
 * clearFamilyStorage: the shared teardown for "this user has no family any
 * more". Two callers reach it: the silent recovery path in this module, and the
 * dialog's re-verification join (`dialog/useReauth.ts`), which only learns of an
 * owner-initiated removal AFTER the user supplied a correct secret (the server's
 * verification gate answers before its kicked-tombstone check). Both must tear
 * down identically, so the behaviour is pinned here once. It deliberately does
 * NOT invoke `onFamilyRemoved` — reacting in the UI is the caller's business and
 * the two callers do it at different moments. It sends no message of its own
 * (#366: the message it used to send had no receiver).
 *  - Binding and endpoint go in ONE local removal (#492): there is no state with
 *    the binding still standing and the endpoint already reset (a bound client
 *    talking to the wrong server), nor with a token left and its endpoint gone.
 *    Before, the endpoint keys went in a second removal, so another tab's join
 *    (`persistJoinCredentials`: familyId + self-hosted token + endpoint in one
 *    `set`) landing between the two kept its token but lost its endpoint, and
 *    that token would then go to the official default.
 *  - A failed removal rejects as a whole, keeping familyId AND endpoint
 *    together. The callers handle it: `dialog/useReauth.ts`'s catch resets the
 *    endpoint itself, and App's handler puts the LIVE client back on the default.
 *
 * Another tab's join mid-teardown (`afterFirstWrite`): the hook runs one write
 * right after the next local storage write takes hold, i.e. right after the
 * teardown's first removal. The store implementations are restored in
 * `afterEach`, so the hook cannot leak into the file's other suites.
 *
 * Stored token issuer: every token this module stores (refresh and recovery join) is
 * written in ONE `set` together with the server that issued it (`moo:authTokenServer`:
 * the session's endpoint, or `official` for the official default), and every removal
 * of the stored token drops that marker too (`TOKEN_KEYS`). Before the refresh request,
 * a stored token goes back on the client only when its marker matches the stored
 * endpoint; the case with a matching marker is the positive companion of the
 * mismatched ones, so they cannot pass because the token is never read at all.
 */

interface RequestOutcome {
  refresh: ApiResponse<{ token: unknown; expiresAt: unknown }>;
  join: ApiResponse<{ authToken: unknown; expiresAt: unknown }>;
}

/** Tokens in the issued shape (64-char lowercase hex); distinct letters keep a
 *  refreshed token apart from a recovered one. See the header → "Issued credentials". */
const FRESH_TOKEN = "d".repeat(64);
const RECOVERED_TOKEN = "e".repeat(64);
/** Would be accepted if the join fired; the cases using it assert it never does. */
const UNUSED_TOKEN = "f".repeat(64);

/** Build an injected `request` that answers refresh vs. join by path. */
function makeRequest(outcome: Partial<RequestOutcome>) {
  return vi.fn((path: string) => {
    if (path === "/api/auth/refresh") {
      return Promise.resolve(
        outcome.refresh ?? { error: { code: "REFRESH_FAILED", message: "x" } },
      );
    }
    if (path.endsWith("/join")) {
      return Promise.resolve(
        outcome.join ?? { error: { code: "UNKNOWN", message: "x" } },
      );
    }
    return Promise.resolve({});
  }) as never;
}

function makeDeps(
  outcome: Partial<RequestOutcome>,
  isReauthPending: () => boolean = () => false,
) {
  return {
    request: makeRequest(outcome),
    setAuthToken: vi.fn(),
    // The session this suite runs in always matches the seed; losing that match has its own
    // suite, through a real client: tests/unit/api/tokenBinding.test.ts.
    beginSession: vi.fn(() => ({
      endpoint: SEEDED_ENDPOINT,
      isLive: () => true,
    })),
    onFamilyRemoved: vi.fn(),
    onReauthRequired: vi.fn(),
    isReauthPending: vi.fn(isReauthPending),
  };
}

/** Accepted self-hosted endpoint, seeded so every branch's effect on the
 *  family-scoped endpoint keys is observable. See the header → "Family-scoped endpoint". */
const SEEDED_ENDPOINT = "https://family.example.com";

/** Seed userId/familyId into the ONE shared store, then wipe the seeding calls
 *  from the spies. Why not a frozen `get` stub: see the header → "Storage seeding". */
async function seedStorage(
  data: Record<string, unknown> = {
    [USER_ID_KEY]: "u1",
    [FAMILY_ID_KEY]: "fam-1",
    [AUTH_TOKEN_KEY]: "old-token",
    [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
    [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
  },
): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.sync.clear();
  await chrome.storage.local.set(data);
  vi.mocked(chrome.storage.local.clear).mockClear();
  vi.mocked(chrome.storage.sync.clear).mockClear();
  vi.mocked(chrome.storage.local.set).mockClear();
}

/** True when family data (FAMILY_ID_KEY) was removed from storage. */
function familyWasCleared(): boolean {
  return vi
    .mocked(chrome.storage.local.remove)
    .mock.calls.some(
      (call) =>
        Array.isArray(call[0]) && (call[0] as string[]).includes(FAMILY_ID_KEY),
    );
}

/** True when BOTH family-scoped endpoint keys (`FAMILY_ENDPOINT_CHOICE_KEYS`: the
 *  accepted endpoint + the declined marker) were removed in one call. */
function endpointChoiceWasReset(): boolean {
  return vi
    .mocked(chrome.storage.local.remove)
    .mock.calls.some(
      (call) =>
        Array.isArray(call[0]) &&
        (call[0] as string[]).includes(API_ENDPOINT_KEY) &&
        (call[0] as string[]).includes(DECLINED_FAMILY_ENDPOINT_KEY),
    );
}

/** What the store still holds for the two family-scoped endpoint keys. */
async function storedEndpointChoice(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get([
    API_ENDPOINT_KEY,
    DECLINED_FAMILY_ENDPOINT_KEY,
  ]);
}

/** True when the recovery cooldown key was removed (cleared) from storage. */
function cooldownWasCleared(): boolean {
  return vi
    .mocked(chrome.storage.local.remove)
    .mock.calls.some(
      (call) => (call[0] as unknown) === RECOVERY_COOLDOWN_UNTIL_KEY,
    );
}

/** The epoch-ms deadline the cooldown key was last written with, or undefined. */
function cooldownWriteValue(): number | undefined {
  const calls = vi.mocked(chrome.storage.local.set).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const arg = calls[i][0] as Record<string, unknown>;
    if (arg && RECOVERY_COOLDOWN_UNTIL_KEY in arg) {
      return arg[RECOVERY_COOLDOWN_UNTIL_KEY] as number;
    }
  }
  return undefined;
}

/** Inspect the injected request spy: how many `/join` requests were issued? */
function joinRequestCount(request: unknown): number {
  const spy = request as ReturnType<typeof vi.fn>;
  return spy.mock.calls.filter((call) => String(call[0]).endsWith("/join"))
    .length;
}

/** Inspect the injected request spy: was any `/join` request issued? */
function joinWasRequested(request: unknown): boolean {
  return joinRequestCount(request) > 0;
}

/** Every `storage.local.set` payload production wrote that carries a token. */
function tokenWrites(): Record<string, unknown>[] {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.map((call) => call[0] as Record<string, unknown>)
    .filter((items) => AUTH_TOKEN_KEY in items);
}

/** The token keys every removal of the stored token must drop, the issuing server included. */
const TOKEN_KEYS = [AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, TOKEN_SERVER_KEY];

describe("doRefreshToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // The setup mock's store is module-scoped: clear it before restoring, while
    // the store-backed implementations are still installed.
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.restoreAllMocks();
  });

  it("returns not-refreshed without calling request when userId/familyId are missing", async () => {
    await seedStorage({}); // no userId/familyId
    const deps = makeDeps({
      refresh: { data: { token: FRESH_TOKEN, expiresAt: 1 } },
    });

    const result = await doRefreshToken(deps);

    expect(result.refreshed).toBe(false);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("stores the new token and reports refreshed when refresh succeeds", async () => {
    await seedStorage();
    const deps = makeDeps({
      refresh: { data: { token: FRESH_TOKEN, expiresAt: 9999 } },
    });

    const result = await doRefreshToken(deps);

    expect(result.refreshed).toBe(true);
    expect(deps.setAuthToken).toHaveBeenCalledWith(FRESH_TOKEN);
    // Token, expiry and the issuing server (the session's) in ONE write.
    expect(tokenWrites()).toEqual([
      {
        [AUTH_TOKEN_KEY]: FRESH_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 9999,
        [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
      },
    ]);
    // No recovery/clear path was taken.
    expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
    expect(deps.onReauthRequired).not.toHaveBeenCalled();
    expect(familyWasCleared()).toBe(false);
  });

  it("recovers via joinFamily and reports refreshed when refresh fails but join succeeds", async () => {
    await seedStorage();
    const deps = makeDeps({
      refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
      join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
    });

    const result = await doRefreshToken(deps);

    expect(result.refreshed).toBe(true);
    expect(deps.setAuthToken).toHaveBeenCalledWith(RECOVERED_TOKEN);
    expect(tokenWrites()).toEqual([
      {
        [AUTH_TOKEN_KEY]: RECOVERED_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 8888,
        [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
      },
    ]);
    expect(deps.onReauthRequired).not.toHaveBeenCalled();
    expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
    expect(familyWasCleared()).toBe(false);
  });

  // A token / expiry in the wrong shape counts as not issued. See the header →
  // "Issued credentials".
  describe("issued credential shape (#350)", () => {
    /** True when production wrote `key` in any `storage.local.set` call. */
    function storageKeyWasWritten(key: string): boolean {
      return vi
        .mocked(chrome.storage.local.set)
        .mock.calls.some((call) => key in (call[0] as Record<string, unknown>));
    }

    const BAD_TOKENS: Array<{ name: string; token: unknown }> = [
      { name: "a short string", token: "garbage" },
      { name: "63 hex chars", token: "d".repeat(63) },
      { name: "65 hex chars", token: "d".repeat(65) },
      { name: "uppercase hex", token: "D".repeat(64) },
      { name: "a number", token: 12345 },
      { name: "an object", token: { value: FRESH_TOKEN } },
    ];

    const BAD_EXPIRIES: Array<{ name: string; expiresAt: unknown }> = [
      { name: "a word", expiresAt: "soon" },
      { name: "a numeric string", expiresAt: "1700000000000" },
      { name: "NaN", expiresAt: Number.NaN },
      { name: "Infinity", expiresAt: Number.POSITIVE_INFINITY },
      { name: "0", expiresAt: 0 },
      { name: "a negative number", expiresAt: -1 },
    ];

    for (const c of BAD_EXPIRIES) {
      it(`stores a valid refreshed token but not an expiresAt that is ${c.name}`, async () => {
        await seedStorage();
        const deps = makeDeps({
          refresh: { data: { token: FRESH_TOKEN, expiresAt: c.expiresAt } },
        });

        const result = await doRefreshToken(deps);

        expect(result).toEqual({ refreshed: true });
        expect(deps.setAuthToken).toHaveBeenCalledWith(FRESH_TOKEN);
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [AUTH_TOKEN_KEY]: FRESH_TOKEN,
          [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
        });
        expect(storageKeyWasWritten(TOKEN_EXPIRES_AT_KEY)).toBe(false);
        expect(joinWasRequested(deps.request)).toBe(false);
      });
    }

    for (const c of BAD_TOKENS) {
      it(`treats a refreshed token that is ${c.name} as a failed refresh and recovers via join`, async () => {
        await seedStorage();
        const deps = makeDeps({
          refresh: { data: { token: c.token, expiresAt: 9999 } },
          join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
        });

        const result = await doRefreshToken(deps);

        // The failure branch: the old token is dropped, then staged recovery runs.
        expect(deps.setAuthToken).toHaveBeenCalledWith(null);
        expect(chrome.storage.local.remove).toHaveBeenCalledWith(TOKEN_KEYS);
        expect(joinRequestCount(deps.request)).toBe(1);
        expect(deps.setAuthToken).not.toHaveBeenCalledWith(c.token);
        expect(result).toEqual({ refreshed: true });
        expect(await chrome.storage.local.get(AUTH_TOKEN_KEY)).toEqual({
          [AUTH_TOKEN_KEY]: RECOVERED_TOKEN,
        });
        expect(storageKeyWasWritten(TOKEN_EXPIRES_AT_KEY)).toBe(true);
      });
    }

    for (const c of BAD_TOKENS) {
      it(`reports a recovery join whose authToken is ${c.name} as a transient failure`, async () => {
        await seedStorage();
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: { data: { authToken: c.token, expiresAt: 8888 } },
        });

        const result = await doRefreshToken(deps);

        // No error code → the transient branch: nothing stored, nothing torn down.
        expect(result).toEqual({ refreshed: false });
        expect(deps.setAuthToken).not.toHaveBeenCalledWith(c.token);
        expect(storageKeyWasWritten(AUTH_TOKEN_KEY)).toBe(false);
        expect(storageKeyWasWritten(TOKEN_EXPIRES_AT_KEY)).toBe(false);
        expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
        expect(deps.onReauthRequired).not.toHaveBeenCalled();
        expect(familyWasCleared()).toBe(false);
        expect(endpointChoiceWasReset()).toBe(false);
        expect(cooldownWriteValue()).toBeUndefined();
        expect(cooldownWasCleared()).toBe(false);
      });
    }

    it("stores a recovered token but not an expiresAt in the wrong shape", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { data: { authToken: RECOVERED_TOKEN, expiresAt: "soon" } },
      });

      const result = await doRefreshToken(deps);

      expect(result).toEqual({ refreshed: true });
      expect(deps.setAuthToken).toHaveBeenCalledWith(RECOVERED_TOKEN);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [AUTH_TOKEN_KEY]: RECOVERED_TOKEN,
        [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
      });
      expect(storageKeyWasWritten(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    });
  });

  describe("recovery-failure branching by join error code", () => {
    interface Case {
      name: string;
      code: string | undefined;
      expectReauth: boolean;
      expectFamilyRemoved: boolean;
      expectCleared: boolean;
    }

    const cases: Case[] = [
      {
        name: "VERIFICATION_REQUIRED → prompt re-verify, keep data",
        code: "VERIFICATION_REQUIRED",
        expectReauth: true,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
      {
        name: "VERIFICATION_FAILED → prompt re-verify, keep data",
        code: "VERIFICATION_FAILED",
        expectReauth: true,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
      {
        name: "VERIFICATION_LOCKED → prompt re-verify, keep data",
        code: "VERIFICATION_LOCKED",
        expectReauth: true,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
      {
        name: "FAMILY_NOT_FOUND → clear family + notify",
        code: "FAMILY_NOT_FOUND",
        expectReauth: false,
        expectFamilyRemoved: true,
        expectCleared: true,
      },
      {
        name: "FAMILY_FULL → clear family + notify",
        code: "FAMILY_FULL",
        expectReauth: false,
        expectFamilyRemoved: true,
        expectCleared: true,
      },
      {
        name: "MEMBER_REMOVED → clear family + notify",
        code: "MEMBER_REMOVED",
        expectReauth: false,
        expectFamilyRemoved: true,
        expectCleared: true,
      },
      {
        // #263: the server refuses a `recovery: 1` join from a user no longer
        // listed — the user left or deleted the account elsewhere.
        name: "RECOVERY_NOT_MEMBER → clear family + notify",
        code: "RECOVERY_NOT_MEMBER",
        expectReauth: false,
        expectFamilyRemoved: true,
        expectCleared: true,
      },
      {
        name: "no error code (network-ish) → leave data intact",
        code: undefined,
        expectReauth: false,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        await seedStorage();
        const join = c.code ? { error: { code: c.code, message: "x" } } : {}; // no data.authToken and no error.code
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: join as ApiResponse<{ authToken: string; expiresAt: number }>,
        });

        const result = await doRefreshToken(deps);

        expect(result.refreshed).toBe(false);
        expect(deps.onReauthRequired).toHaveBeenCalledTimes(
          c.expectReauth ? 1 : 0,
        );
        expect(deps.onFamilyRemoved).toHaveBeenCalledTimes(
          c.expectFamilyRemoved ? 1 : 0,
        );
        expect(familyWasCleared()).toBe(c.expectCleared);
        if (c.expectFamilyRemoved) {
          // The dialog is told WHICH refusal tore the binding down, so the
          // onboarding view can name the reason instead of flipping silently.
          expect(deps.onFamilyRemoved).toHaveBeenCalledWith({
            errorCode: c.code,
          });
        }
        // The FAMILY-scoped endpoint: the gone branch drops it, every retryable
        // branch keeps it. See the header → "Family-scoped endpoint".
        expect(endpointChoiceWasReset()).toBe(c.expectCleared);
        expect(await storedEndpointChoice()).toEqual(
          c.expectCleared
            ? {}
            : {
                [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
                [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
              },
        );
      });
    }
  });

  // Owner-initiated removal (403 MEMBER_REMOVED from the kicked tombstone) must
  // count as family-gone. See the header → "MEMBER_REMOVED".
  describe("MEMBER_REMOVED (owner-initiated removal)", () => {
    it("clears family data from local and sync storage", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { error: { code: "MEMBER_REMOVED", message: "removed" } },
      });

      const result = await doRefreshToken(deps);

      // Terminal, not rate-limited: no cooldown is written, so the outcome
      // carries no retry hint for the UI to count down on.
      expect(result).toEqual({ refreshed: false });
      expect(cooldownWriteValue()).toBeUndefined();
      // Dropped from BOTH storage areas — a synced familyId left behind would
      // let another device hand the local one back and resume rejoining.
      expect(familyWasCleared()).toBe(true);
      expect(chrome.storage.sync.remove).toHaveBeenCalledWith([FAMILY_ID_KEY]);
      expect(deps.onFamilyRemoved).toHaveBeenCalledTimes(1);
      expect(deps.onFamilyRemoved).toHaveBeenCalledWith({
        errorCode: "MEMBER_REMOVED",
      });
      // The family's endpoint goes with the membership (else the NEXT create/join
      // leaks to the ex-family's server). See the header → "Family-scoped endpoint".
      expect(await storedEndpointChoice()).toEqual({});
      // A removal is not a verification problem — never prompt for a secret.
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
    });

    it("stops the silent auto-rejoin: a later refresh issues no second join", async () => {
      // Two calls against ONE store: the second sees the familyId removal the
      // first left behind, which is what has to stop the rejoin.
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { error: { code: "MEMBER_REMOVED", message: "removed" } },
      });

      const first = await doRefreshToken(deps);
      const second = await doRefreshToken(deps);

      expect(first.refreshed).toBe(false);
      expect(second.refreshed).toBe(false);
      // Exactly one join ever leaves the client: the removal is not retried.
      expect(joinRequestCount(deps.request)).toBe(1);
      const stored = await chrome.storage.local.get(FAMILY_ID_KEY);
      expect(stored[FAMILY_ID_KEY]).toBeUndefined();
      // The user is told once, not on every subsequent request wave.
      expect(deps.onFamilyRemoved).toHaveBeenCalledTimes(1);
    });
  });

  // The verification branch reports WHAT blocked recovery, so the dialog opens the
  // prompt in the right state (locked + countdown vs. plain challenge).
  describe("onReauthRequired payload", () => {
    it("passes the blocking code and retryAfter from a 429 lockout", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: {
          error: {
            code: "VERIFICATION_LOCKED",
            message: "locked",
            retryAfter: 120,
          },
        },
      });

      await doRefreshToken(deps);

      expect(deps.onReauthRequired).toHaveBeenCalledWith({
        errorCode: "VERIFICATION_LOCKED",
        retryAfter: 120,
      });
      // Invariant 2: a lockout must never drop the user's family data.
      expect(familyWasCleared()).toBe(false);
    });

    it("passes the code with an undefined retryAfter when the backend omits it", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { error: { code: "VERIFICATION_REQUIRED", message: "verify" } },
      });

      await doRefreshToken(deps);

      expect(deps.onReauthRequired).toHaveBeenCalledWith({
        errorCode: "VERIFICATION_REQUIRED",
        retryAfter: undefined,
      });
    });
  });

  it("always clears only the token (not family) before attempting recovery", async () => {
    await seedStorage();
    const deps = makeDeps({
      refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
      join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
    });

    await doRefreshToken(deps);

    // Token is cleared regardless of the recovery branch...
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(TOKEN_KEYS);
    // ...but the verification branch must NOT clear family data or the endpoint:
    // the re-supplied secret's join has to reach the SAME server.
    expect(familyWasCleared()).toBe(false);
    expect(endpointChoiceWasReset()).toBe(false);
    expect(await storedEndpointChoice()).toEqual({
      [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
      [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
    });
  });

  it("does not throw when onReauthRequired is null on a verification failure", async () => {
    await seedStorage();
    const deps = {
      request: makeRequest({
        refresh: { error: { code: "REFRESH_FAILED", message: "x" } },
        join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
      }),
      setAuthToken: vi.fn(),
      beginSession: () => ({ endpoint: SEEDED_ENDPOINT, isLive: () => true }),
      onFamilyRemoved: null,
      onReauthRequired: null,
      isReauthPending: () => false,
    };

    const result = await doRefreshToken(deps);
    expect(result.refreshed).toBe(false);
    expect(familyWasCleared()).toBe(false);
  });

  describe("recovery cooldown (rate limiting)", () => {
    // Pin the clock so cooldown deadlines (Date.now() + seconds*1000) are exact.
    const FIXED_NOW = 1_700_000_000_000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    interface CooldownCase {
      name: string;
      retryAfter: number | undefined;
      expectedSeconds: number;
    }

    // Wait clamped to 1h (MAX_RECOVERY_COOLDOWN_SECONDS); non-positive/absent → 300s.
    // See the header → "Recovery cooldown clamp".
    const cases: CooldownCase[] = [
      {
        name: "derives the cooldown from the join's retryAfter",
        retryAfter: 120,
        expectedSeconds: 120,
      },
      {
        name: "falls back to 300s when the 429 omits retryAfter",
        retryAfter: undefined,
        expectedSeconds: 300,
      },
      {
        name: "caps an oversized retryAfter (24h) at the 1h maximum",
        retryAfter: 86_400,
        expectedSeconds: 3600,
      },
      {
        name: "keeps a retryAfter sitting exactly on the 1h cap",
        retryAfter: 3600,
        expectedSeconds: 3600,
      },
      {
        name: "keeps a retryAfter just under the 1h cap unclamped",
        retryAfter: 3599,
        expectedSeconds: 3599,
      },
      {
        name: "falls back to 300s when retryAfter is 0",
        retryAfter: 0,
        expectedSeconds: 300,
      },
      {
        name: "falls back to 300s when retryAfter is negative",
        retryAfter: -60,
        expectedSeconds: 300,
      },
    ];

    for (const c of cases) {
      it(`${c.name} on a fresh RATE_LIMITED recovery`, async () => {
        await seedStorage(); // no cooldown key → no active cooldown
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: {
            error: {
              code: "RATE_LIMITED",
              message: "too many",
              ...(c.retryAfter !== undefined
                ? { retryAfter: c.retryAfter }
                : {}),
            },
          } as ApiResponse<{ authToken: string; expiresAt: number }>,
        });

        const result = await doRefreshToken(deps);

        const expectedUntil = FIXED_NOW + c.expectedSeconds * 1000;
        expect(result).toEqual({
          refreshed: false,
          rateLimited: true,
          cooldownUntil: expectedUntil,
        });
        // Cooldown was persisted with the derived deadline.
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [RECOVERY_COOLDOWN_UNTIL_KEY]: expectedUntil,
        });
        expect(cooldownWriteValue()).toBe(expectedUntil);
        // A rate-limit must NOT prompt verification nor drop family data —
        // the family-scoped endpoint included (needed once the window clears).
        expect(deps.onReauthRequired).not.toHaveBeenCalled();
        expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
        expect(familyWasCleared()).toBe(false);
        expect(endpointChoiceWasReset()).toBe(false);
      });
    }

    it("skips the join entirely while a cooldown is still active", async () => {
      const activeUntil = FIXED_NOW + 60_000; // 60s in the future
      await seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
        [RECOVERY_COOLDOWN_UNTIL_KEY]: activeUntil,
      });
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        // Accepted if the join fired; the cooldown must keep it from firing.
        join: { data: { authToken: UNUSED_TOKEN, expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result).toEqual({
        refreshed: false,
        rateLimited: true,
        cooldownUntil: activeUntil,
      });
      // The quota-sensitive join must be suppressed entirely.
      expect(joinWasRequested(deps.request)).toBe(false);
      // No fresh cooldown write and no data loss on the suppressed path.
      expect(cooldownWriteValue()).toBeUndefined();
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(familyWasCleared()).toBe(false);
    });

    // The persisted deadline is clamped on READ too (1h max); the clamped value is
    // returned AND persisted back. See the header → "Recovery cooldown clamp".
    describe("clamping a persisted cooldown on read", () => {
      const HOUR_MS = 3_600_000;

      interface ReadCase {
        name: string;
        storedOffsetMs: number;
        expectedOffsetMs: number;
        /** Deadline re-saved by the read clamp; undefined = nothing written. */
        expectedWrite: number | undefined;
      }

      const readCases: ReadCase[] = [
        {
          name: "passes a 60s deadline through unchanged",
          storedOffsetMs: 60_000,
          expectedOffsetMs: 60_000,
          expectedWrite: undefined,
        },
        {
          name: "passes a deadline sitting exactly on the 1h cap through unchanged",
          storedOffsetMs: HOUR_MS,
          expectedOffsetMs: HOUR_MS,
          expectedWrite: undefined,
        },
        {
          name: "clamps a deadline 1ms past the 1h cap",
          storedOffsetMs: HOUR_MS + 1,
          expectedOffsetMs: HOUR_MS,
          expectedWrite: FIXED_NOW + HOUR_MS,
        },
        {
          name: "clamps a 24h deadline down to the 1h cap",
          storedOffsetMs: 24 * HOUR_MS,
          expectedOffsetMs: HOUR_MS,
          expectedWrite: FIXED_NOW + HOUR_MS,
        },
      ];

      for (const c of readCases) {
        it(c.name, async () => {
          await seedStorage({
            [USER_ID_KEY]: "u1",
            [FAMILY_ID_KEY]: "fam-1",
            [AUTH_TOKEN_KEY]: "old-token",
            [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
            [RECOVERY_COOLDOWN_UNTIL_KEY]: FIXED_NOW + c.storedOffsetMs,
          });
          const deps = makeDeps({
            refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
            // Accepted if the join fired; the cooldown must keep it from firing.
            join: { data: { authToken: UNUSED_TOKEN, expiresAt: 8888 } },
          });

          const result = await doRefreshToken(deps);

          expect(result).toEqual({
            refreshed: false,
            rateLimited: true,
            cooldownUntil: FIXED_NOW + c.expectedOffsetMs,
          });
          // Still an active cooldown, so the join stays suppressed; only an
          // over-long deadline is re-persisted (at the cap), and nothing is dropped.
          expect(joinWasRequested(deps.request)).toBe(false);
          expect(cooldownWriteValue()).toBe(c.expectedWrite);
          expect(deps.onReauthRequired).not.toHaveBeenCalled();
          expect(familyWasCleared()).toBe(false);
        });
      }

      it("lets a legacy 10-day cooldown expire 1h later instead of after 10 days", async () => {
        await seedStorage({
          [USER_ID_KEY]: "u1",
          [FAMILY_ID_KEY]: "fam-1",
          [AUTH_TOKEN_KEY]: "old-token",
          [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
          [RECOVERY_COOLDOWN_UNTIL_KEY]: FIXED_NOW + 240 * HOUR_MS,
        });
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
        });

        const first = await doRefreshToken(deps);
        // Two hours on, past the 1h cap but far short of the stored 10 days.
        vi.setSystemTime(FIXED_NOW + 2 * HOUR_MS);
        const second = await doRefreshToken(deps);

        expect(first.rateLimited).toBe(true);
        expect(second.refreshed).toBe(true);
        expect(joinRequestCount(deps.request)).toBe(1);
      });

      it("ignores a non-number persisted cooldown and attempts the join", async () => {
        await seedStorage({
          [USER_ID_KEY]: "u1",
          [FAMILY_ID_KEY]: "fam-1",
          [AUTH_TOKEN_KEY]: "old-token",
          [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
          // Corrupted/legacy value — must not be treated as an active cooldown.
          [RECOVERY_COOLDOWN_UNTIL_KEY]: String(FIXED_NOW + 60_000),
        });
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
        });

        const result = await doRefreshToken(deps);

        expect(result.refreshed).toBe(true);
        expect(joinWasRequested(deps.request)).toBe(true);
      });
    });

    it("attempts the join when the stored cooldown has expired", async () => {
      await seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
        [RECOVERY_COOLDOWN_UNTIL_KEY]: FIXED_NOW - 1_000, // already expired
      });
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result.refreshed).toBe(true);
      expect(joinWasRequested(deps.request)).toBe(true);
      // A successful recovery clears the stale cooldown.
      expect(cooldownWasCleared()).toBe(true);
    });

    it("clears the cooldown after a successful refresh", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { data: { token: FRESH_TOKEN, expiresAt: 9999 } },
      });

      const result = await doRefreshToken(deps);

      expect(result.refreshed).toBe(true);
      expect(cooldownWasCleared()).toBe(true);
    });

    it("clears the cooldown after a successful join recovery", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result.refreshed).toBe(true);
      expect(cooldownWasCleared()).toBe(true);
    });

    it("does not prompt re-verification (onReauthRequired) on a rate-limited recovery", async () => {
      await seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: {
          error: { code: "RATE_LIMITED", message: "too many", retryAfter: 42 },
        } as ApiResponse<{ authToken: string; expiresAt: number }>,
      });

      const result = await doRefreshToken(deps);

      expect(result.rateLimited).toBe(true);
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
    });
  });

  // While `isReauthPending()` is true the refresh POST runs but silent join-recovery
  // is skipped. See the header → "Reauth-pending latch".
  describe("reauth-pending latch", () => {
    it("skips join recovery and all side effects when isReauthPending() is true", async () => {
      await seedStorage();
      const deps = makeDeps(
        {
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          // Accepted if the join fired; the latch must keep it from firing.
          join: { data: { authToken: UNUSED_TOKEN, expiresAt: 8888 } },
        },
        () => true,
      );

      const result = await doRefreshToken(deps);

      expect(result).toEqual({ refreshed: false });
      // The quota-sensitive join is suppressed entirely.
      expect(joinWasRequested(deps.request)).toBe(false);
      // No prompt re-fire, no data drop, no cooldown write on the latched path.
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
      expect(familyWasCleared()).toBe(false);
      expect(cooldownWriteValue()).toBeUndefined();
    });

    it("proceeds with join recovery when isReauthPending() is false", async () => {
      await seedStorage();
      const deps = makeDeps(
        {
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
        },
        () => false,
      );

      const result = await doRefreshToken(deps);

      // Latch open → the join fires and the verification branch prompts re-verify.
      expect(result.refreshed).toBe(false);
      expect(joinWasRequested(deps.request)).toBe(true);
      expect(deps.onReauthRequired).toHaveBeenCalledTimes(1);
      expect(familyWasCleared()).toBe(false);
    });
  });

  // See the header → "Stored token issuer".
  describe("stored token issuer", () => {
    const OFFICIAL = validateEndpointUrl(DEFAULT_API_ENDPOINT);
    const OTHER_SERVER = "https://other.example";

    function onOfficial(deps: ReturnType<typeof makeDeps>) {
      deps.beginSession.mockReturnValue({
        endpoint: OFFICIAL,
        isLive: () => true,
      });
      return deps;
    }

    async function seedOfficial(): Promise<void> {
      await seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
      });
    }

    it("stores a refreshed token from the official default with the official marker", async () => {
      await seedOfficial();
      const deps = onOfficial(
        makeDeps({
          refresh: { data: { token: FRESH_TOKEN, expiresAt: 9999 } },
        }),
      );

      await expect(doRefreshToken(deps)).resolves.toEqual({ refreshed: true });

      expect(tokenWrites()).toEqual([
        {
          [AUTH_TOKEN_KEY]: FRESH_TOKEN,
          [TOKEN_EXPIRES_AT_KEY]: 9999,
          [TOKEN_SERVER_KEY]: "official",
        },
      ]);
    });

    it("stores a recovered token from the official default with the official marker", async () => {
      await seedOfficial();
      const deps = onOfficial(
        makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
        }),
      );

      await expect(doRefreshToken(deps)).resolves.toEqual({ refreshed: true });

      expect(tokenWrites()).toEqual([
        {
          [AUTH_TOKEN_KEY]: RECOVERED_TOKEN,
          [TOKEN_EXPIRES_AT_KEY]: 8888,
          [TOKEN_SERVER_KEY]: "official",
        },
      ]);
    });

    it.each([
      { name: "another server's marker", marker: OTHER_SERVER },
      { name: "the official marker", marker: "official" },
    ])(
      "does not put a stored token with $name on the client before the refresh",
      async ({ marker }) => {
        await seedStorage({
          [USER_ID_KEY]: "u1",
          [FAMILY_ID_KEY]: "fam-1",
          [AUTH_TOKEN_KEY]: "old-token",
          [TOKEN_SERVER_KEY]: marker,
          [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
        });
        const deps = makeDeps({
          refresh: { data: { token: FRESH_TOKEN, expiresAt: 9999 } },
        });

        await doRefreshToken(deps);

        expect(deps.request).toHaveBeenCalledWith(
          "/api/auth/refresh",
          expect.anything(),
          true,
        );
        expect(deps.setAuthToken).not.toHaveBeenCalledWith("old-token");
      },
    );

    it("puts a stored token whose marker matches on the client before the refresh", async () => {
      await seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
        [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
      });
      const deps = makeDeps({
        refresh: { data: { token: FRESH_TOKEN, expiresAt: 9999 } },
      });

      await doRefreshToken(deps);

      const setToken = vi.mocked(deps.setAuthToken);
      const request = deps.request as unknown as ReturnType<typeof vi.fn>;
      expect(setToken.mock.calls[0]).toEqual(["old-token"]);
      expect(setToken.mock.invocationCallOrder[0]).toBeLessThan(
        request.mock.invocationCallOrder[0],
      );
      expect(request.mock.calls[0][0]).toBe("/api/auth/refresh");
    });

    it("drops the stored issuer with the token on a failed refresh", async () => {
      await seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [TOKEN_EXPIRES_AT_KEY]: 123,
        [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
        [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
      });
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
      });

      await doRefreshToken(deps);

      expect(await chrome.storage.local.get(TOKEN_KEYS)).toEqual({});
      expect(
        (await chrome.storage.local.get(FAMILY_ID_KEY))[FAMILY_ID_KEY],
      ).toBe("fam-1");
    });
  });

  // `recovery: 1` (#263) lets the server refuse an unlisted user; displayName is
  // omitted so the member's chosen name is kept.
  it("sends the recovery join with exactly { userId, recovery: 1 }", async () => {
    await seedStorage();
    const deps = makeDeps({
      refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
      join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
    });

    await doRefreshToken(deps);

    const joinCall = (
      deps.request as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find((call) => String(call[0]).endsWith("/join"));
    expect(joinCall?.[0]).toBe("/api/family/fam-1/join");
    const init = joinCall?.[1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      userId: "u1",
      recovery: BoolFlag.TRUE,
    });
  });

  // #263: while the user's own departure is in flight, the silent join is skipped
  // but the refresh POST still runs. See the header → "Own departure in flight".
  describe("own departure in flight (#263)", () => {
    let endDeparture: (() => Promise<void>) | undefined;

    afterEach(async () => {
      await endDeparture?.();
      endDeparture = undefined;
    });

    it("skips the silent join and keeps the family data while the mark is up", async () => {
      await seedStorage();
      endDeparture = await beginSelfDeparture();
      vi.mocked(chrome.storage.local.set).mockClear();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        // Would re-add the user if the join fired — it must NOT fire.
        join: { data: { authToken: UNUSED_TOKEN, expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result).toEqual({ refreshed: false });
      // The refresh POST itself still went out, first and alone.
      expect(deps.request).toHaveBeenCalledTimes(1);
      expect(
        (deps.request as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
      ).toBe("/api/auth/refresh");
      expect(joinWasRequested(deps.request)).toBe(false);
      // Family data and its endpoint are kept; no prompt, no cooldown.
      expect(familyWasCleared()).toBe(false);
      expect(await storedEndpointChoice()).toEqual({
        [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
      });
      const stored = await chrome.storage.local.get(FAMILY_ID_KEY);
      expect(stored[FAMILY_ID_KEY]).toBe("fam-1");
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
      expect(cooldownWriteValue()).toBeUndefined();
    });

    it("still reports refreshed when the refresh POST succeeds under the mark", async () => {
      await seedStorage();
      endDeparture = await beginSelfDeparture();
      const deps = makeDeps({
        refresh: { data: { token: FRESH_TOKEN, expiresAt: 9999 } },
      });

      const result = await doRefreshToken(deps);

      expect(result).toEqual({ refreshed: true });
      expect(deps.setAuthToken).toHaveBeenCalledWith(FRESH_TOKEN);
      expect(joinWasRequested(deps.request)).toBe(false);
    });

    it("joins again once the departure has settled", async () => {
      // Positive companion: the skip above is the mark's doing, not a join
      // path that never fires.
      await seedStorage();
      const end = await beginSelfDeparture();
      await end();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { data: { authToken: RECOVERED_TOKEN, expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result).toEqual({ refreshed: true });
      expect(joinRequestCount(deps.request)).toBe(1);
    });
  });
});

// The SINGLE definition of "the join target is gone for this user"; family-gone vs
// verification/rate-limit is load-bearing. See the header → "isFamilyGoneError".
describe("isFamilyGoneError", () => {
  it.each([
    ["FAMILY_NOT_FOUND", true],
    ["FAMILY_FULL", true],
    ["MEMBER_REMOVED", true],
    ["RECOVERY_NOT_MEMBER", true],
    ["VERIFICATION_REQUIRED", false],
    ["VERIFICATION_FAILED", false],
    ["VERIFICATION_LOCKED", false],
    ["RATE_LIMITED", false],
    ["SERVER_ERROR", false],
    ["", false],
    [undefined, false],
  ])("returns %s → %s", (code, expected) => {
    expect(isFamilyGoneError(code as string | undefined)).toBe(expected);
  });
});

const NEW_FAMILY = "fam-new";
const SELF_HOSTED_TOKEN = "b".repeat(64);
const SELF_HOSTED_URL = "https://self-hosted.example";

type StorageWrite = Mock<(arg: unknown) => Promise<void>>;
const localSet = browser.storage.local.set as unknown as StorageWrite;
const localRemove = browser.storage.local.remove as unknown as StorageWrite;
const storeSet = localSet.getMockImplementation()!;
const storeRemove = localRemove.getMockImplementation()!;

/** Run `effect` once, right after the next local storage write takes hold. */
function afterFirstWrite(effect: () => Promise<void>): void {
  let fired = false;
  const firing =
    (store: (arg: unknown) => Promise<void>) => async (arg: unknown) => {
      await store(arg);
      if (fired) return;
      fired = true;
      await effect();
    };
  localSet.mockImplementation(firing(storeSet));
  localRemove.mockImplementation(firing(storeRemove));
}

// Shared "no family any more" teardown for the silent path and `dialog/useReauth.ts`;
// never calls `onFamilyRemoved`. See the header → "clearFamilyStorage".
describe("clearFamilyStorage", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: "u1",
      [FAMILY_ID_KEY]: "fam-1",
      [AUTH_TOKEN_KEY]: "old-token",
      [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
      [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
    });
    await chrome.storage.sync.set({ [FAMILY_ID_KEY]: "fam-1" });
    // Seeding calls are wiped so the assertions only observe production's.
    vi.clearAllMocks();
  });

  afterEach(async () => {
    localSet.mockImplementation(storeSet);
    localRemove.mockImplementation(storeRemove);
    // The store behind the setup mock is module-scoped: clear it while the
    // store-backed implementations are still installed.
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.restoreAllMocks();
  });

  it("drops the familyId from BOTH storage areas", async () => {
    await clearFamilyStorage();

    const local = await chrome.storage.local.get(FAMILY_ID_KEY);
    expect(local[FAMILY_ID_KEY]).toBeUndefined();
    // A synced familyId left behind would let another device hand the local one
    // back and resume exactly the rejoin loop the removal exists to stop.
    const synced = await chrome.storage.sync.get(FAMILY_ID_KEY);
    expect(synced[FAMILY_ID_KEY]).toBeUndefined();
  });

  // The FAMILY-scoped endpoint and the declined marker must not outlive the
  // membership. See the header → "Family-scoped endpoint".
  describe("family-scoped endpoint reset", () => {
    it("drops both the accepted endpoint and the declined marker", async () => {
      await clearFamilyStorage();

      const local = await chrome.storage.local.get([
        API_ENDPOINT_KEY,
        DECLINED_FAMILY_ENDPOINT_KEY,
      ]);
      expect(local).toEqual({});
    });

    it("removes the family binding and the endpoint keys in one local removal", async () => {
      await clearFamilyStorage();

      // One removal, no gap between binding and endpoint. See the header → "clearFamilyStorage".
      const removeCalls = vi.mocked(chrome.storage.local.remove).mock.calls;
      expect(removeCalls).toHaveLength(1);
      expect(removeCalls[0][0]).toEqual([
        FAMILY_ID_KEY,
        STORE_PAGE_INDEX_KEY,
        AUTH_TOKEN_KEY,
        TOKEN_EXPIRES_AT_KEY,
        TOKEN_SERVER_KEY,
        API_ENDPOINT_KEY,
        DECLINED_FAMILY_ENDPOINT_KEY,
      ]);
    });

    // A failed removal rejects as a whole and keeps familyId, token and endpoint
    // together. See the header → "clearFamilyStorage".
    it("rejects and keeps the family, its token and its endpoint when the removal fails", async () => {
      vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );

      await expect(clearFamilyStorage()).rejects.toThrow("storage unavailable");

      const synced = await chrome.storage.sync.get(FAMILY_ID_KEY);
      expect(synced[FAMILY_ID_KEY]).toBe("fam-1");
      const local = await chrome.storage.local.get(null);
      expect(local).toMatchObject({
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [API_ENDPOINT_KEY]: SEEDED_ENDPOINT,
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
      });
    });

    // See the header → "Another tab's join mid-teardown".
    it("never leaves another tab's self-hosted token without its endpoint (#492)", async () => {
      const otherTab = vi.fn(async () => {
        await storeSet({
          [FAMILY_ID_KEY]: NEW_FAMILY,
          [AUTH_TOKEN_KEY]: SELF_HOSTED_TOKEN,
          [API_ENDPOINT_KEY]: SELF_HOSTED_URL,
        });
      });
      afterFirstWrite(otherTab);

      await clearFamilyStorage();

      expect(otherTab).toHaveBeenCalledTimes(1);
      const local = await chrome.storage.local.get(null);
      expect(local[FAMILY_ID_KEY]).toBe(NEW_FAMILY);
      expect(local[AUTH_TOKEN_KEY]).toBe(SELF_HOSTED_TOKEN);
      expect(local[API_ENDPOINT_KEY]).toBe(SELF_HOSTED_URL);
    });
  });

  it("removes the family's token, its expiry and its issuer and keeps the userId", async () => {
    await chrome.storage.local.set({
      [TOKEN_EXPIRES_AT_KEY]: 123,
      [TOKEN_SERVER_KEY]: SEEDED_ENDPOINT,
    });

    await clearFamilyStorage();

    // A token left behind would pair with the official default once the same removal drops the
    // endpoint (#456, #492); the userId is the user's own and outlives the family (Invariant 5).
    const local = await chrome.storage.local.get([
      USER_ID_KEY,
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
      TOKEN_SERVER_KEY,
    ]);
    expect(local[USER_ID_KEY]).toBe("u1");
    expect(local[AUTH_TOKEN_KEY]).toBeUndefined();
    expect(local[TOKEN_EXPIRES_AT_KEY]).toBeUndefined();
    expect(local[TOKEN_SERVER_KEY]).toBeUndefined();
  });

  it("still clears locally when sync storage is unavailable", async () => {
    vi.mocked(chrome.storage.sync.remove).mockRejectedValueOnce(
      new Error("sync unavailable"),
    );

    await expect(clearFamilyStorage()).resolves.toBeUndefined();

    // Local removal is authoritative and independent of the sync outcome.
    const local = await chrome.storage.local.get(FAMILY_ID_KEY);
    expect(local[FAMILY_ID_KEY]).toBeUndefined();
  });
});
