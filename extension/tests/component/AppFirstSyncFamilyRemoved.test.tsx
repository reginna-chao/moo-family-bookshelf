import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { App } from "@/dialog/App";
import { forgetAccountConfirmation } from "@/dialog/accountIdentityCheck";
import { familyGoneNoticeText } from "@/dialog/familyGoneNotice";
import { AUTO_SYNC_INTERVAL_KEY, DEFAULT_API_ENDPOINT } from "@/constants";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import { encodeSyncCode } from "moo-family-bookshelf-shared/crypto/syncCode";
import { readMePageProfile } from "@/content/hashNavigation";
import { clearReadmooEmailCookie } from "../helpers/readmooEmailCookie";

/**
 * Issue #476: a family teardown landing during onboarding's first sync must leave the user on a
 * fresh welcome screen under the removal notice, not in the main view of a gone family.
 *
 * The scenario: the join (or auto-recovery) succeeds, and the first upload's read of the saved list
 * answers 401. The refresh fails and the recovery join answers a family-gone code, so the client
 * calls `onFamilyRemoved` from inside `syncBooks`. App clears the family and shows Onboarding with
 * the notice. `syncBooks` then returns to the flow that started it, which calls `onFamilyJoined`
 * unconditionally, because an ordinary sync failure must not block entry. Before the fix that call
 * cleared the notice and entered the main view, whose requests carried the gone family's id to the
 * official server: the teardown had already reset the client's endpoint.
 *
 * Two changes close it, and both teardown cases go red when either is removed alone:
 * `unmountFamilyTreeThenResetClient` unmounts Onboarding, and `useOnFamilyJoinedWhileMounted` drops
 * the call from the instance that was unmounted. Without the first the instance never unmounts, so
 * the guard lets the call through. Without the second the unmounted instance still reaches App.
 *
 * What is real: `App`, `Onboarding` and its flow hooks, `ApiClient`, the staged refresh, storage
 * teardown and the main view. Stubbed: `fetch`, plus the host page. `readMePageProfile` returns the
 * account's email and `navigateAndRun` skips its settle (the real pair would wait 1.5 s four times
 * per journey), and `scrapeBooks` returns an empty library, since the failure lands before any
 * scraped book matters.
 *
 * The end-of-flow signal: nothing on screen marks the old flow's end, because the correct outcome
 * renders nothing new. `syncBooks` restores the page hash as its last step on every path and returns
 * straight into the hand-off, and the mocked host page touches the hash nowhere else, so `#/` means
 * the hand-off has run or is one microtask away. The ordinary-failure case calibrates that wait: it
 * asserts the tablist and the members request SYNCHRONOUSLY after the same `settleFlowEnd`, proving
 * a wrongly entered main view would already be visible to the negative assertions. It also pins the
 * members URL those assertions filter on.
 *
 * The assertions are soft so that a failure reports the whole outcome at once: the tablist, the
 * welcome screen, the notice and the requests fail for different reasons.
 */

vi.mock("@/content/hashNavigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/content/hashNavigation")>()),
  readMePageProfile: vi.fn(),
  navigateAndRun: vi.fn(<T,>(_hash: string, task: () => T | Promise<T>) =>
    Promise.resolve().then(task),
  ),
}));

vi.mock("@/content/scraper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/content/scraper")>()),
  scrapeBooks: vi.fn(() => Promise.resolve([])),
}));

const SELF_HOSTED = "https://selfhost.example";
const EMAIL = "reader@example.com";
const FAMILY_ID = "abcd-efgh";
const OWNER_ID = "c".repeat(64);
const AUTH_TOKEN = "d".repeat(64);
const WAIT = { timeout: 5000 };

// Filled in beforeAll: the id the real deriveUserId gives EMAIL.
let userId = "";

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code, message: code } });
}

/** One family's server for the journey; what differs per case is passed in. */
interface ServerScript {
  /** The family `/api/auth/lookup` reveals; null routes the user to the create-or-join screen. */
  existingFamilyId: string | null;
  /** The answer to the first upload's read of the saved list. */
  readBooks: () => Response;
  /** The answer to a join carrying `recovery: 1`; the refresh always fails. */
  recoveryJoin: () => Response;
}

function answer(script: ServerScript, call: RecordedCall): Response {
  const { url, method, body } = call;
  if (url.endsWith("/api/auth/lookup")) {
    const { existingFamilyId } = script;
    return jsonResponse(200, {
      data: { existingFamilyId, memberCount: existingFamilyId ? 1 : 0 },
    });
  }
  if (url.endsWith(`/api/family/${FAMILY_ID}/join`)) {
    if (body?.includes('"recovery":1')) return script.recoveryJoin();
    return jsonResponse(200, {
      data: {
        familyId: FAMILY_ID,
        ownerId: OWNER_ID,
        members: [{ userId, displayName: "" }],
        maxMembers: 6,
        createdAt: "2026-01-01T00:00:00.000Z",
        authToken: AUTH_TOKEN,
        expiresAt: Date.now() + 86_400_000,
      },
    });
  }
  if (url.endsWith(`/api/user/${userId}/books`) && method === "GET") {
    return script.readBooks();
  }
  if (url.endsWith("/api/auth/refresh")) {
    return errorResponse(401, "UNAUTHORIZED");
  }
  if (url.endsWith(`/api/family/${FAMILY_ID}/members`)) {
    return jsonResponse(200, {
      data: {
        familyId: FAMILY_ID,
        ownerId: OWNER_ID,
        members: [{ userId, displayName: "Me" }],
      },
    });
  }
  if (url.endsWith(`/api/family/${FAMILY_ID}/bookshelf`)) {
    return jsonResponse(200, { data: { familyId: FAMILY_ID, members: [] } });
  }
  return errorResponse(404, "NOT_FOUND");
}

function stubFetch(script: ServerScript): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(answer(script, call));
  }) as unknown as typeof fetch;
  return calls;
}

const familyCallsTo = (calls: RecordedCall[], origin: string): string[] =>
  calls
    .map(({ url }) => url)
    .filter((url) => url.startsWith(`${origin}/api/family/`));

const callsTo = (calls: RecordedCall[], origin: string): string[] =>
  calls
    .filter(({ url }) => url.startsWith(origin))
    .map(({ method, url }) => `${method} ${url.slice(origin.length)}`);

function queryWelcomeStart(): HTMLElement | null {
  return screen.queryByRole("button", { name: /開始使用|繼續使用/ });
}

/** Boot with no family and press start; the lookup the click triggers decides what comes next. */
async function pressStart(): Promise<void> {
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /開始使用|繼續使用/ }, WAIT),
  );
}

async function joinWithSyncCode(): Promise<void> {
  await pressStart();
  const input = await screen.findByPlaceholderText(
    "輸入家庭同步碼",
    undefined,
    WAIT,
  );
  fireEvent.change(input, {
    target: {
      value: encodeSyncCode({ familyId: FAMILY_ID, apiHost: SELF_HOSTED }),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "加入家庭公開書櫃" }));
}

/** Waits out the old flow, then gives a hand-off one macrotask to render and send. See the header →
 *  "The end-of-flow signal". */
async function settleFlowEnd(): Promise<void> {
  await waitFor(() => expect(window.location.hash).toBe("#/"), WAIT);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function expectWelcomeUnderNotice(errorCode: string): void {
  expect.soft(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect.soft(queryWelcomeStart()).toBeInTheDocument();
  expect
    .soft(screen.queryByRole("alert"))
    .toHaveTextContent(familyGoneNoticeText(errorCode));
}

describe("App when a family teardown lands during onboarding's first sync (#476)", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, "crypto", {
        value: webcrypto,
        writable: true,
      });
    }
    userId = await deriveUserId(EMAIL);
    expect(DEFAULT_API_ENDPOINT).not.toBe(SELF_HOSTED);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    forgetAccountConfirmation();
    clearReadmooEmailCookie();
    window.location.hash = "";
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.mocked(readMePageProfile).mockResolvedValue({
      email: EMAIL,
      displayName: "Reader",
    });
  });

  // Unmounts the tree, then undoes the journey's state: fetch, account confirmation, hash, storage.
  afterEach(async () => {
    cleanup();
    globalThis.fetch = originalFetch;
    forgetAccountConfirmation();
    window.location.hash = "";
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
  });

  it("stays on the welcome screen under the notice after a sync-code join to a self-hosted server", async () => {
    const calls = stubFetch({
      existingFamilyId: null,
      readBooks: () => errorResponse(401, "UNAUTHORIZED"),
      recoveryJoin: () => errorResponse(403, "MEMBER_REMOVED"),
    });

    await joinWithSyncCode();
    await settleFlowEnd();

    expectWelcomeUnderNotice("MEMBER_REMOVED");
    expect.soft(familyCallsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
    // The teardown really ran off the first read, on the family's own server, and nothing followed.
    expect
      .soft(callsTo(calls, SELF_HOSTED))
      .toEqual([
        `POST /api/family/${FAMILY_ID}/join`,
        `GET /api/user/${userId}/books`,
        "POST /api/auth/refresh",
        `POST /api/family/${FAMILY_ID}/join`,
      ]);
  });

  it("stays on the welcome screen under the notice after the start flow's auto-recovery", async () => {
    const calls = stubFetch({
      existingFamilyId: FAMILY_ID,
      readBooks: () => errorResponse(401, "UNAUTHORIZED"),
      recoveryJoin: () => errorResponse(404, "FAMILY_NOT_FOUND"),
    });

    await pressStart();
    await settleFlowEnd();

    expectWelcomeUnderNotice("FAMILY_NOT_FOUND");
    // No sync code here, so the official server is the family's own.
    expect
      .soft(callsTo(calls, DEFAULT_API_ENDPOINT))
      .toEqual([
        "POST /api/auth/lookup",
        `POST /api/family/${FAMILY_ID}/join`,
        `GET /api/user/${userId}/books`,
        "POST /api/auth/refresh",
        `POST /api/family/${FAMILY_ID}/join`,
      ]);
  });

  it("still enters the main view when the first sync fails with the family still there", async () => {
    // The main view's own auto-sync would outlive the test on a real 1.5 s wait.
    await chrome.storage.local.set({ [AUTO_SYNC_INTERVAL_KEY]: "never" });
    const calls = stubFetch({
      existingFamilyId: null,
      readBooks: () => errorResponse(500, "INTERNAL_ERROR"),
      recoveryJoin: () => errorResponse(500, "NO_RECOVERY_EXPECTED"),
    });

    await joinWithSyncCode();
    await settleFlowEnd();

    // Synchronous on purpose. See the header → "The end-of-flow signal".
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(familyCallsTo(calls, SELF_HOSTED)).toContain(
      `${SELF_HOSTED}/api/family/${FAMILY_ID}/members`,
    );
    expect(familyCallsTo(calls, DEFAULT_API_ENDPOINT)).toEqual([]);
    // A 500 starts no refresh, so no teardown can have run here.
    expect(calls.map(({ url }) => url)).not.toContain(
      `${SELF_HOSTED}/api/auth/refresh`,
    );
  });
});
