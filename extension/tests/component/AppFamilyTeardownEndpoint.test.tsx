import { Profiler } from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { App } from "@/dialog/App";
import { ApiClient, BoolFlag } from "@/api/client";
import { clearFamilyStorage } from "@/api/familyStorageClear";
import {
  markAccountConfirmed,
  forgetAccountConfirmation,
} from "@/dialog/accountIdentityCheck";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  USER_ID_KEY,
} from "@/constants";
import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";
import { familyPrefRef } from "moo-family-bookshelf-shared/familyShelf/prefRefs";

/**
 * Issue #454 (privacy): a family teardown must not send a pending family-shelf preference to the
 * official server.
 *
 * Why this fails silently: `ApiClient.request` reads `baseUrl` at send time, and
 * `FamilyPrefsSync.detach()` flushes a change still inside the 600 ms debounce from an unmount
 * cleanup. App used to call `setEndpoint(DEFAULT_API_ENDPOINT)` before the commit that unmounts
 * `FamilyDataProvider`, so a self-hosted family's favorites / hidden refs (owner ids + book ids)
 * went to a server that family never chose. `FamilyPrefsSync` and the client are each correct on
 * their own; only App's ORDER was wrong, so only a test through the real App can pin it.
 *
 * What is real: `App`, `FamilyDataProvider`, `useFamilyShelfPrefs`, `FamilyPrefsSync`, `ApiClient`,
 * the favorite button and the settings leave flow. Only `fetch` is stubbed, plus what
 * `tests/setup.ts` already provides. Unlike tests/component/App.test.tsx, no module is mocked.
 *
 * Reaching the client: App keeps it in a private ref, so a pass-through spy on
 * `ApiClient.prototype.setEndpoint` reads it off the boot call (`applyStoredSession`) as
 * `mock.contexts[0]`. `markAccountConfirmed` skips the 1.5 s `#/me` hash navigation at boot.
 *
 * Timers are real: the teardown lands inside the debounce window, and RTL waiters cannot see a
 * fake clock (`.claude/rules/test.md` → Fake timers exclude RTL waiters).
 *
 * The prefs-load readiness signal: the server already holds one favorite, and its filled heart
 * appearing proves the load succeeded while attached (`onRefs` publishes only then). Toggling
 * before that would replay the change as a pre-load delta, a different path.
 *
 * The pending-reload interleaving (last case): a re-verification bumps `reloadSignal`, and the
 * effect that resends a failed save (`FamilyPrefsSync.load()`) runs in a LATER Scheduler task than
 * the commit. A teardown landing between the two must flush that effect before the endpoint
 * switches. `act` would drain both tasks together, so this case runs on the real Scheduler: the
 * submit continuation lands inside `waitFor`, which turns the act environment off. A public
 * `<Profiler onRender>` fires during that commit and does two things: burns past the Scheduler's
 * 5 ms slice, so it yields before the passive-effect task, and queues a microtask, which runs in
 * that gap. The microtask is the teardown. `putsBeforeTeardown` proves the effect was still
 * pending: had it run first, the count would already be 2.
 *
 * The in-flight members request: a removed member's first request is what discovers the removal, so
 * the teardown (401 → refresh 401 → recovery join refused → `onFamilyRemoved`) always runs INSIDE
 * `await refreshMembers()`. No timing is involved. By the time that await returns, the client points
 * at the official server, and the follow-up bookshelf and borrow URLs carry the familyId, so the load
 * must stop there. Those two loads have no `mountedRef` check before their fetch; only the initial
 * load's own `stale` flag stops them. The healthy-load case is the positive companion: it pins the
 * URLs the negative assertion filters on.
 *
 * The token half of the reset: the client also reads its token at send time, so the leave flush must
 * still carry the family's Bearer token while the next request must not. That next request is the
 * real `POST /api/auth/lookup` behind Onboarding's start button. Reaching it needs the `#/me` panel
 * in the page, so the case seeds that markup and waits out the real 1.5 s hash-navigation settle.
 * The removal route is not asserted on this: App clears the token before its teardown there, and the
 * token is already dead on the refresh path.
 *
 * The failed-save resend: `detach()` also resends a save that already failed, so the toggle waits out
 * the real debounce and fails BEFORE `prepare()`, while the family shelf and its notice are on screen.
 * A 500 keeps the refresh flow out of it. When that resend gets a 401 instead, it answers for a server
 * the client has already left, so the client hands the 401 back and refreshes nowhere (#456). Leaving
 * clears storage inside its own handler; the removal route's real caller (`clearFamilyAndNotify`) clears
 * it before `onFamilyRemoved`, which `clearStorageFirst` mirrors since `run` calls the handler directly.
 * Two saves on the family's server show the 401 was really sent, and no refresh on any server plus an
 * empty official server show it stopped there. The positive companion for that URL filter is the
 * "starts no bookshelf or borrow load" case, whose refresh does run.
 */

const SELF_HOSTED = "https://selfhost.example";
const USER_ID = "a".repeat(64);
const MEMBER_ID = "c".repeat(64);
const AUTH_TOKEN = "d".repeat(64);
const FRESH_TOKEN = "e".repeat(64);
const FAMILY_ID = "abcd-efgh";
const TOGGLED_BOOK_ID = "210439468000111";
const FAVORITED_BOOK_ID = "210439468000112";
const TOGGLED_REF = familyPrefRef(MEMBER_ID, TOGGLED_BOOK_ID);
const FAVORITED_REF = familyPrefRef(MEMBER_ID, FAVORITED_BOOK_ID);
const WAIT = { timeout: 5000 };

const SYNC_FAILED_NOTICE = /收藏與隱藏暫時無法同步/;

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | undefined;
}

type Responder = (call: RecordedCall) => Response | null;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function familyResponse(call: RecordedCall): Response | null {
  const { url, method } = call;
  if (url.endsWith(`/api/family/${FAMILY_ID}/members`)) {
    return jsonResponse(200, {
      data: {
        familyId: FAMILY_ID,
        ownerId: MEMBER_ID,
        apiEndpoint: SELF_HOSTED,
        members: [
          { userId: USER_ID, displayName: "Me" },
          { userId: MEMBER_ID, displayName: "Alice" },
        ],
      },
    });
  }
  if (url.endsWith(`/api/family/${FAMILY_ID}/bookshelf`)) {
    return jsonResponse(200, {
      data: {
        familyId: FAMILY_ID,
        members: [
          {
            userId: MEMBER_ID,
            displayName: "Alice",
            books: [
              {
                bookId: TOGGLED_BOOK_ID,
                title: "第一本",
                author: "A",
                isShared: BoolFlag.TRUE,
              },
              {
                bookId: FAVORITED_BOOK_ID,
                title: "第二本",
                author: "B",
                isShared: BoolFlag.TRUE,
              },
            ],
          },
        ],
      },
    });
  }
  if (url.endsWith(`/api/user/${USER_ID}/books`)) {
    return jsonResponse(200, {
      data: {
        books: [],
        familyShelfPrefs: { hidden: [], favorites: [FAVORITED_REF] },
      },
    });
  }
  if (method === "DELETE") return jsonResponse(200, { data: { ok: true } });
  if (url.endsWith("/family-prefs")) {
    return jsonResponse(200, {
      data: { ok: true, hidden: [], favorites: [TOGGLED_REF, FAVORITED_REF] },
    });
  }
  return null;
}

/** Route the journey and record every call: the URL is how the endpoint in force becomes observable.
 *  `responder` answers first, for the cases that need a dead token. */
function stubFetch(responder?: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: (init?.headers as Record<string, string> | undefined)
        ?.Authorization,
    };
    calls.push(call);
    const response =
      responder?.(call) ??
      familyResponse(call) ??
      jsonResponse(404, {
        error: { code: "NOT_FOUND", message: `unrouted ${call.url}` },
      });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return calls;
}

/** Answers a dead token the real way: the save gets a 401, refresh fails, the silent recovery join
 *  hits the verification gate, and the join carrying the PIN succeeds. */
function deadTokenResponder(): Responder {
  let savesAnswered = 0;
  return ({ url, method, body }) => {
    if (url.endsWith("/family-prefs") && savesAnswered === 0) {
      savesAnswered += 1;
      return jsonResponse(401, {
        error: { code: "UNAUTHORIZED", message: "dead token" },
      });
    }
    if (url.endsWith("/api/auth/refresh")) {
      return jsonResponse(401, {
        error: { code: "UNAUTHORIZED", message: "dead token" },
      });
    }
    if (url.endsWith(`/api/user/${USER_ID}/verify`) && method === "GET") {
      return jsonResponse(200, { data: { method: "pin", prompted: 1 } });
    }
    if (url.endsWith(`/api/family/${FAMILY_ID}/join`)) {
      if (!body?.includes("verifySecret")) {
        return jsonResponse(403, {
          error: { code: "VERIFICATION_REQUIRED", message: "需要驗證" },
        });
      }
      return jsonResponse(200, {
        data: {
          familyId: FAMILY_ID,
          ownerId: MEMBER_ID,
          members: [{ userId: USER_ID, displayName: "Me" }],
          maxMembers: 6,
          createdAt: "2026-01-01T00:00:00.000Z",
          authToken: FRESH_TOKEN,
          expiresAt: Date.now() + 86_400_000,
        },
      });
    }
    return null;
  };
}

/** A removed member's dead token: members and refresh answer 401, the recovery join is refused. */
function removedMemberResponder(status: number, code: string): Responder {
  return ({ url }) => {
    if (
      url.endsWith(`/api/family/${FAMILY_ID}/members`) ||
      url.endsWith("/api/auth/refresh")
    ) {
      return jsonResponse(401, {
        error: { code: "UNAUTHORIZED", message: "dead token" },
      });
    }
    if (url.endsWith(`/api/family/${FAMILY_ID}/join`)) {
      return jsonResponse(status, { error: { code, message: "gone" } });
    }
    return null;
  };
}

const noFamilyLookupResponder: Responder = ({ url }) =>
  url.endsWith("/api/auth/lookup")
    ? jsonResponse(200, { data: { existingFamilyId: null, memberCount: 0 } })
    : null;

const isPrefsSave = (call: RecordedCall): boolean =>
  call.method === "PUT" && call.url.endsWith("/family-prefs");

/** Answers the prefs saves with these statuses in order; any later save takes the healthy route. */
function failingSavesResponder(...statuses: number[]): Responder {
  const remaining = [...statuses];
  return (call) => {
    if (!isPrefsSave(call)) return null;
    const status = remaining.shift();
    if (status === undefined) return null;
    return jsonResponse(status, {
      error: { code: "SAVE_FAILED", message: "save failed" },
    });
  };
}

/** The two loads the initial load starts once members have answered. */
const followUpLoads = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter(
    ({ url }) =>
      url.endsWith(`/api/family/${FAMILY_ID}/bookshelf`) ||
      url.endsWith(`/api/family/${FAMILY_ID}/borrow`),
  );

const callsTo = (calls: RecordedCall[], origin: string): RecordedCall[] =>
  calls.filter((call) => call.url.startsWith(origin));

const prefsCallsTo = (calls: RecordedCall[], origin: string): RecordedCall[] =>
  calls.filter(
    (call) => call.url.startsWith(origin) && call.url.includes("/family-prefs"),
  );

function savedFavorites(call: RecordedCall | undefined): string[] {
  return (
    (JSON.parse(call?.body ?? "{}") as { favorites?: string[] }).favorites ?? []
  );
}

function toggleFavorite(): void {
  fireEvent.click(screen.getByRole("button", { name: "加入最愛" }));
}

/** runReauthJoin clears the cooldown right before `onSuccess` bumps `reloadSignal`, so the first
 *  commit after this turns true is the reload commit. */
function reverificationLanded(): boolean {
  return vi
    .mocked(chrome.storage.local.remove)
    .mock.calls.some(
      (args: unknown[]) => args[0] === RECOVERY_COOLDOWN_UNTIL_KEY,
    );
}

function findOnboardingStart(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: /開始使用|繼續使用/ }, WAIT);
}

async function expectOnboarding(): Promise<void> {
  await findOnboardingStart();
}

/** One macrotask: whatever was queued behind the torn-down request has had its turn. */
async function drainContinuations(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The Readmoo `#/me` panel Onboarding's start button reads the account from. */
function seedMePanel(): void {
  const panel = document.createElement("div");
  panel.className = READMOO_SELECTORS.mePanel.slice(1);
  const emailLine = document.createElement("div");
  emailLine.setAttribute("style", "color: gray");
  emailLine.textContent = "reader@example.com";
  panel.append(emailLine);
  document.body.append(panel);
}

interface TeardownRoute {
  name: string;
  /** Anything the route needs on screen before the toggle starts the debounce. */
  prepare: () => Promise<void>;
  /** The storage clearing a real caller does before `run`'s entry point (see the header). */
  clearStorageFirst: () => Promise<void>;
  /** Runs the teardown; returns the endpoint read as soon as the route can observe it. */
  run: (client: ApiClient) => Promise<string>;
}

const LEAVE_ROUTE: TeardownRoute = {
  name: "leaving the family through the settings confirm",
  prepare: async () => {
    fireEvent.click(screen.getByRole("tab", { name: "設定" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "離開家庭" }, WAIT),
    );
  },
  clearStorageFirst: () => Promise.resolve(),
  // handleLeaveFamily runs after the DELETE's await, so its return is observed through Onboarding.
  run: async (client) => {
    fireEvent.click(screen.getByRole("button", { name: "確定離開" }));
    await expectOnboarding();
    return client.getEndpoint();
  },
};

const TEARDOWN_ROUTES: TeardownRoute[] = [
  LEAVE_ROUTE,
  {
    name: "being removed through the client's onFamilyRemoved",
    prepare: () => Promise.resolve(),
    clearStorageFirst: clearFamilyStorage,
    // Read inside `act`, before its own flush: the value the handler returned with.
    run: async (client) => {
      let endpoint = "";
      act(() => {
        client.onFamilyRemoved?.({ errorCode: "FAMILY_NOT_FOUND" });
        endpoint = client.getEndpoint();
      });
      await expectOnboarding();
      return endpoint;
    },
  },
];

describe("App family teardown and the API endpoint", () => {
  const originalFetch = globalThis.fetch;
  let setEndpointSpy: MockInstance<ApiClient["setEndpoint"]>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  /** Waits for the prefs load to land (see the header), then returns App's live client. */
  async function waitForLoadedFamilyShelf(): Promise<ApiClient> {
    await screen.findByRole("button", { name: "取消最愛" }, WAIT);
    const client = setEndpointSpy.mock.contexts[0] as ApiClient;
    expect(client.getEndpoint()).toBe(SELF_HOSTED);
    return client;
  }

  function flushSyncComplaints(): unknown[][] {
    return consoleErrorSpy.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes("flushSync")),
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.local.set({
      [FAMILY_ID_KEY]: FAMILY_ID,
      [USER_ID_KEY]: USER_ID,
      [AUTH_TOKEN_KEY]: AUTH_TOKEN,
      [API_ENDPOINT_KEY]: SELF_HOSTED,
    });
    markAccountConfirmed(USER_ID);
    setEndpointSpy = vi.spyOn(ApiClient.prototype, "setEndpoint");
    consoleErrorSpy = vi.spyOn(console, "error");
    expect(DEFAULT_API_ENDPOINT).not.toBe(SELF_HOSTED);
  });

  afterEach(async () => {
    setEndpointSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    globalThis.fetch = originalFetch;
    forgetAccountConfirmation();
    document.querySelector(READMOO_SELECTORS.mePanel)?.remove();
    window.location.hash = "";
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
  });

  it.each(TEARDOWN_ROUTES)(
    "sends a pending favorite to the family's own server when $name",
    async ({ prepare, run }) => {
      const calls = stubFetch();
      render(<App />);
      const client = await waitForLoadedFamilyShelf();
      await prepare();

      // Nothing awaited from here to `run`: the debounce cannot fire in between.
      toggleFavorite();
      expect(calls.filter(isPrefsSave)).toEqual([]);

      const endpointAfterTeardown = await run(client);

      const saves = prefsCallsTo(calls, SELF_HOSTED).filter(isPrefsSave);
      expect(saves).toHaveLength(1);
      expect(savedFavorites(saves[0]).sort()).toEqual(
        [FAVORITED_REF, TOGGLED_REF].sort(),
      );
      expect(prefsCallsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
      expect(endpointAfterTeardown).toBe(DEFAULT_API_ENDPOINT);
      expect(flushSyncComplaints()).toEqual([]);
    },
  );

  it.each(TEARDOWN_ROUTES)(
    "resends a failed save to the family's own server when $name",
    async ({ prepare, run }) => {
      const calls = stubFetch(failingSavesResponder(500));
      render(<App />);
      const client = await waitForLoadedFamilyShelf();

      toggleFavorite();
      await screen.findByText(SYNC_FAILED_NOTICE, undefined, WAIT);
      expect(calls.filter(isPrefsSave)).toHaveLength(1);
      await prepare();

      const endpointAfterTeardown = await run(client);

      const saves = prefsCallsTo(calls, SELF_HOSTED).filter(isPrefsSave);
      expect(saves).toHaveLength(2);
      expect(savedFavorites(saves[1]).sort()).toEqual(
        [FAVORITED_REF, TOGGLED_REF].sort(),
      );
      expect(prefsCallsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
      expect(endpointAfterTeardown).toBe(DEFAULT_API_ENDPOINT);
      expect(flushSyncComplaints()).toEqual([]);
    },
  );

  it.each(TEARDOWN_ROUTES)(
    "sends nothing to the official server when the resend gets a 401 after $name",
    async ({ prepare, clearStorageFirst, run }) => {
      const calls = stubFetch(failingSavesResponder(500, 401));
      render(<App />);
      const client = await waitForLoadedFamilyShelf();

      toggleFavorite();
      await screen.findByText(SYNC_FAILED_NOTICE, undefined, WAIT);
      await prepare();
      await clearStorageFirst();

      await run(client);
      await drainContinuations();

      // See the header → "The failed-save resend".
      expect(prefsCallsTo(calls, SELF_HOSTED).filter(isPrefsSave)).toHaveLength(
        2,
      );
      expect(
        calls.filter(({ url }) => url.endsWith("/api/auth/refresh")),
      ).toEqual([]);
      expect(callsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
    },
  );

  it("starts the bookshelf and borrow loads on the family's own server once members answer", async () => {
    const calls = stubFetch();
    render(<App />);
    await waitForLoadedFamilyShelf();

    await waitFor(
      () =>
        expect(
          followUpLoads(calls)
            .map(({ url }) => url)
            .sort(),
        ).toEqual([
          `${SELF_HOSTED}/api/family/${FAMILY_ID}/bookshelf`,
          `${SELF_HOSTED}/api/family/${FAMILY_ID}/borrow`,
        ]),
      WAIT,
    );
  });

  it.each([
    { code: "MEMBER_REMOVED", status: 403 },
    { code: "FAMILY_NOT_FOUND", status: 404 },
  ])(
    "starts no bookshelf or borrow load when the members request ends in a $code teardown",
    async ({ code, status }) => {
      const calls = stubFetch(removedMemberResponder(status, code));
      render(<App />);

      await expectOnboarding();
      await drainContinuations();

      expect(followUpLoads(calls)).toEqual([]);
      expect(callsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
      // The teardown really ran off the members request, on the family's own server.
      expect(
        calls
          .map(({ url }) => url)
          .filter(
            (url) => !url.endsWith("/books") && !url.endsWith("/api/version"),
          ),
      ).toEqual([
        `${SELF_HOSTED}/api/family/${FAMILY_ID}/members`,
        `${SELF_HOSTED}/api/auth/refresh`,
        `${SELF_HOSTED}/api/family/${FAMILY_ID}/join`,
      ]);
    },
  );

  it("carries the family's token on the leave flush, then sends the next request without it", async () => {
    const calls = stubFetch(noFamilyLookupResponder);
    render(<App />);
    const client = await waitForLoadedFamilyShelf();
    await LEAVE_ROUTE.prepare();

    toggleFavorite();
    await LEAVE_ROUTE.run(client);

    const saves = prefsCallsTo(calls, SELF_HOSTED).filter(isPrefsSave);
    expect(saves.map(({ authorization }) => authorization)).toEqual([
      `Bearer ${AUTH_TOKEN}`,
    ]);

    seedMePanel();
    fireEvent.click(await findOnboardingStart());
    await screen.findByRole("button", { name: "建立家庭公開書櫃" }, WAIT);

    expect(
      callsTo(calls, DEFAULT_API_ENDPOINT).map((call) => [
        call.method,
        call.url,
        call.authorization,
      ]),
    ).toEqual([["POST", `${DEFAULT_API_ENDPOINT}/api/auth/lookup`, undefined]]);
  });

  it("resends a failed save to the family's own server when the teardown beats the reload effect", async () => {
    let fired = false;
    let teardown: {
      putsBeforeTeardown: number;
      putsAfterTeardown: number;
      endpoint: string;
    } | null = null;
    const calls = stubFetch(deadTokenResponder());

    const onCommit = () => {
      if (fired || !reverificationLanded()) return;
      fired = true;
      queueMicrotask(() => {
        const client = setEndpointSpy.mock.contexts[0] as ApiClient;
        const putsBeforeTeardown = calls.filter(isPrefsSave).length;
        client.onFamilyRemoved?.({ errorCode: "FAMILY_NOT_FOUND" });
        teardown = {
          putsBeforeTeardown,
          putsAfterTeardown: calls.filter(isPrefsSave).length,
          endpoint: client.getEndpoint(),
        };
      });
      // See the header → "The pending-reload interleaving".
      const start = performance.now();
      while (performance.now() - start < 6) {
        // Burn past the Scheduler's 5 ms slice.
      }
    };

    render(
      <Profiler id="app" onRender={onCommit}>
        <App />
      </Profiler>,
    );
    await waitForLoadedFamilyShelf();

    // The real debounce fires, the save meets the dead token, and the failure is recorded.
    toggleFavorite();
    await screen.findByText(SYNC_FAILED_NOTICE, undefined, WAIT);
    const pinInput = await screen.findByLabelText(
      "PIN 碼輸入",
      undefined,
      WAIT,
    );
    expect(calls.filter(isPrefsSave)).toHaveLength(1);

    fireEvent.change(pinInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "確認" }));
    await waitFor(() => expect(teardown).not.toBeNull(), WAIT);

    expect(teardown).toEqual({
      putsBeforeTeardown: 1,
      putsAfterTeardown: 2,
      endpoint: DEFAULT_API_ENDPOINT,
    });
    await expectOnboarding();

    const saves = prefsCallsTo(calls, SELF_HOSTED).filter(isPrefsSave);
    expect(saves).toHaveLength(2);
    expect(savedFavorites(saves[1]).sort()).toEqual(
      [FAVORITED_REF, TOGGLED_REF].sort(),
    );
    expect(prefsCallsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
    expect(flushSyncComplaints()).toEqual([]);
  });
});
