import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "@/dialog/App";
import { API_ENDPOINT_KEY, DEFAULT_API_ENDPOINT } from "@/constants";

/**
 * Lifetime of an ADOPTED-BUT-UNPERSISTED API endpoint across a dialog close.
 *
 * The join attempt-scope safety argument (pinned in
 * tests/unit/useOnboardingFlow.test.ts → "handleJoin endpoint lifetime") rests
 * on one assumption it never states: closing the Dialog UNMOUNTS the React root,
 * so App's in-memory ApiClient — a `useRef(new ApiClient())`, one per mount —
 * dies with it. That is what makes "performJoin persists the `@host` only after
 * the backend accepts" a complete answer: an attempt abandoned mid-challenge
 * leaves the custom endpoint live in memory and nowhere else, so simply closing
 * the dialog is enough to be rid of it.
 *
 * The assumption lives in extension/src/content/index.ts (`disposeDialogShell`
 * / `teardownMooFamilyUI`, which call the `mountDialog` unmount handle BEFORE
 * removing the host element) while the tests relying on it live in the hook
 * suite, with no link between them. If close ever becomes "hide" — keeping the
 * root mounted behind `display: none` — the guarantee evaporates silently. This
 * case makes that change fail a test instead.
 *
 * It is deliberately NOT in tests/component/App.test.tsx: that file mocks
 * `@/dialog/Onboarding` at module scope, and the whole point here is to reach
 * the endpoint through the REAL join flow — down to the real ApiClient, whose
 * `setEndpoint` is what performJoin actually calls.
 */

// crypto.subtle competes with fake timers in this environment (see the same
// mock in tests/component/Onboarding.test.tsx). The value only has to satisfy
// ApiClient's 64-char-hex guard.
const USER_ID = "a".repeat(64);
vi.mock("@/crypto/hash", () => ({
  deriveUserId: vi.fn().mockResolvedValue("a".repeat(64)),
  sha256Hex: vi.fn().mockResolvedValue("b".repeat(64)),
}));

vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("test@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("Test User"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

/** The self-hosted server a sync code's `@host` points the client at. */
const CUSTOM_ENDPOINT = "https://selfhost.example";
const FAMILY_ID = "abcd-efgh";
const SYNC_CODE = `moo-${FAMILY_ID}@${CUSTOM_ENDPOINT}`;

interface RecordedCall {
  url: string;
  method: string;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/**
 * Route the three requests this journey makes, and record every URL — the URL
 * is how the endpoint in force becomes OBSERVABLE without reaching into App's
 * private ref.
 */
function stubFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });

    if (url.endsWith("/api/auth/lookup")) {
      return Promise.resolve(
        jsonResponse(200, {
          data: { existingFamilyId: null, memberCount: 0 },
        }),
      );
    }
    if (url.endsWith(`/api/family/${FAMILY_ID}/join`)) {
      // The sync code's server demands verification: the attempt stalls on the
      // challenge, so nothing is ever persisted.
      return Promise.resolve(
        jsonResponse(403, {
          error: { code: "VERIFICATION_REQUIRED", message: "需要驗證" },
        }),
      );
    }
    if (url.endsWith(`/api/user/${USER_ID}/verify`)) {
      return Promise.resolve(
        jsonResponse(200, { data: { method: "pin", prompted: 0 } }),
      );
    }
    return Promise.resolve(
      jsonResponse(404, {
        error: { code: "NOT_FOUND", message: `unrouted ${url}` },
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

/** Flush the microtask queue while fake timers are installed. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
    vi.advanceTimersByTime(0);
  });
}

/**
 * Press the welcome button and drain scrapeProfile's hash-navigation settle
 * (1500ms) plus the lookup that follows. The label differs between the first
 * and later opens — a stored displayName flips it to 繼續使用 — so match both.
 */
async function startOnboarding(): Promise<void> {
  const welcome = await screen.findByRole("button", {
    name: /開始使用|繼續使用/,
  });
  fireEvent.click(welcome);
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      vi.advanceTimersByTime(500);
      await flushMicrotasks();
    });
  }
}

describe("App dialog close discards the in-memory API endpoint", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The setup.ts storage mock keeps one store for the whole file.
    void chrome.storage.local.clear();
    void chrome.storage.sync.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    void chrome.storage.local.clear();
    void chrome.storage.sync.clear();
  });

  it("re-opens on the default endpoint after a sync-code join stalls on the verification challenge", async () => {
    const calls = stubFetch();

    // --- Open #1: paste an @host sync code and stall on the challenge --------
    const first = render(<App />);
    await startOnboarding();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
      target: { value: SYNC_CODE },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("加入家庭公開書櫃"));
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(screen.getByText("需要驗證")).toBeInTheDocument();
    });

    // The live client really did adopt the @host: the join went there, and the
    // challenge discloses that server to the user about to type a PIN into it.
    expect(calls.map((c) => c.url)).toContain(
      `${CUSTOM_ENDPOINT}/api/family/${FAMILY_ID}/join`,
    );
    expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
      CUSTOM_ENDPOINT,
    );
    // …and nothing durable was written, because the join never succeeded.
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
    );

    // --- Close: the content script unmounts the React root ------------------
    const callsBeforeClose = calls.length;
    first.unmount();

    // --- Open #2: a fresh mount, therefore a fresh ApiClient ----------------
    render(<App />);
    await startOnboarding();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
    });

    const afterClose = calls.slice(callsBeforeClose).map((c) => c.url);
    // The reopened dialog talks to the official endpoint again…
    expect(afterClose).toContain(`${DEFAULT_API_ENDPOINT}/api/auth/lookup`);
    // …and the abandoned attempt's host is gone for good: were the root merely
    // hidden instead of unmounted, this lookup would still be aimed at it.
    expect(afterClose.filter((url) => url.startsWith(CUSTOM_ENDPOINT))).toEqual(
      [],
    );
  });
});
