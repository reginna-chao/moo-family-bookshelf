import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { MOO_ELEMENT_IDS } from "@/utils/extensionContext";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  USER_ID_KEY,
} from "@/constants";
import { BorrowStatus } from "@/api/types";
import type { BorrowRequest } from "@/api/types";

/**
 * Boundary-validation tests for the floating button's pending-borrow badge
 * (`updatePendingBorrowBadge` in the content script).
 *
 * The content script talks to `GET /api/family/:id/borrow` with a bare `fetch`
 * (no ApiClient), so a self-hosted / hostile backend payload reaches it raw.
 * The production path is: read storage → fetch → read `.data` off a real object
 * → `sanitizeBorrowRequests` → filter → `updateBadge`. `sanitizeBorrowRequests`
 * is the REAL production import here (internal utility, never mocked) — the
 * point of this file is pinning that wiring, not the sanitizer in isolation
 * (which `tests/unit/api/borrow-client.test.ts` already covers).
 *
 * Key tripwire: several tests seed a STALE badge before calling. A malformed
 * payload must still reach `updateBadge(button, 0)` and REMOVE that badge. If
 * the validation were removed and the raw payload were cast again, the throw
 * would be swallowed by the function's outer `try/catch` and the stale badge
 * would survive — so these assertions fail on exactly that regression.
 */

// Reject page-ready with an AbortError so the content script's top-level init
// takes its silent "navigation cancelled" branch: no button injection, hence no
// bootstrap-triggered updatePendingBorrowBadge call polluting the fetch /
// storage call counts asserted below. pageReady has its own unit tests.
vi.mock("@/content/pageReady", () => ({
  PAGE_READY_TIMEOUT_MS: 5000,
  waitForPageReady: (): Promise<void> =>
    Promise.reject(new DOMException("aborted", "AbortError")),
}));

// Static import so the vi.mock above is hoisted ahead of module evaluation.
import { updatePendingBorrowBadge } from "@/content/index";

/** Badge id is derived from production's element-id map (anti-drift). */
const BADGE_ID = `${MOO_ELEMENT_IDS.button}-badge`;

const OWNER_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const FAMILY_ID = "fam-abc";
const AUTH_TOKEN = "token-xyz";
const ENDPOINT = "https://test.workers.dev";

type Mock = ReturnType<typeof vi.fn>;

const storageGet = browser.storage.local.get as unknown as Mock;
const originalFetch = globalThis.fetch;

let button: HTMLElement;
let fetchSpy: Mock;
let warnSpy: ReturnType<typeof vi.spyOn>;

function makeBorrowRequest(overrides: Partial<BorrowRequest> = {}) {
  return {
    requestId: "req-1",
    familyId: FAMILY_ID,
    borrowerId: OTHER_ID,
    borrowerName: "Bob",
    ownerId: OWNER_ID,
    bookId: "book-1",
    bookTitle: "The Test Book",
    bookAuthor: "Author A",
    bookCoverUrl: "https://example.com/cover.jpg",
    status: BorrowStatus.PENDING,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } satisfies BorrowRequest;
}

/** The four storage keys the function reads, minus the omitted ones. */
function storageWithout(...omitted: string[]): Record<string, unknown> {
  const full: Record<string, unknown> = {
    [USER_ID_KEY]: OWNER_ID,
    [FAMILY_ID_KEY]: FAMILY_ID,
    [AUTH_TOKEN_KEY]: AUTH_TOKEN,
    [API_ENDPOINT_KEY]: ENDPOINT,
  };
  for (const key of omitted) delete full[key];
  return full;
}

async function seedStorage(entries: Record<string, unknown>): Promise<void> {
  await browser.storage.local.clear();
  await browser.storage.local.set(entries);
}

/** Serve an arbitrary response body; returns the `res.json` spy. */
function serveJson(payload: unknown, ok = true): Mock {
  const jsonSpy = vi.fn().mockResolvedValue(payload);
  fetchSpy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 403,
    json: jsonSpy,
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  return jsonSpy;
}

/** Serve `payload` as the `data` of a 200 envelope. */
function serveData(payload: unknown): Mock {
  return serveJson({ data: payload });
}

function getBadge(): HTMLElement | null {
  return button.querySelector<HTMLElement>(`#${BADGE_ID}`);
}

/** Attach a leftover badge from an earlier (higher) count. */
function seedStaleBadge(text = "9"): void {
  const stale = document.createElement("span");
  stale.id = BADGE_ID;
  stale.textContent = text;
  button.appendChild(stale);
}

beforeEach(async () => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  button = document.createElement("button");
  document.body.appendChild(button);
  await seedStorage(storageWithout());
  serveData([]);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  warnSpy.mockRestore();
  button.remove();
  await browser.storage.local.clear();
});

describe("updatePendingBorrowBadge", () => {
  describe("badge count from a valid payload", () => {
    const COUNT_CASES: Array<{
      name: string;
      requests: BorrowRequest[];
      badge: string | null;
    }> = [
      {
        name: "counts only pending requests owned by the stored user",
        requests: [
          makeBorrowRequest({ requestId: "req-1" }),
          makeBorrowRequest({ requestId: "req-2" }),
          makeBorrowRequest({ requestId: "req-3", ownerId: OTHER_ID }),
          makeBorrowRequest({ requestId: "req-4", status: BorrowStatus.LENT }),
          makeBorrowRequest({
            requestId: "req-5",
            status: BorrowStatus.RETURNED,
          }),
        ],
        badge: "2",
      },
      {
        name: "shows a single-digit count for one pending request",
        requests: [makeBorrowRequest()],
        badge: "1",
      },
      {
        name: "shows no badge when every pending request belongs to another owner",
        requests: [
          makeBorrowRequest({ requestId: "req-1", ownerId: OTHER_ID }),
          makeBorrowRequest({ requestId: "req-2", ownerId: OTHER_ID }),
        ],
        badge: null,
      },
      {
        name: "shows no badge when the user's own requests are all non-pending",
        requests: [
          makeBorrowRequest({ requestId: "req-1", status: BorrowStatus.LENT }),
          makeBorrowRequest({
            requestId: "req-2",
            status: BorrowStatus.RETURNED,
          }),
          makeBorrowRequest({
            requestId: "req-3",
            status: BorrowStatus.REJECTED,
          }),
          makeBorrowRequest({
            requestId: "req-4",
            status: BorrowStatus.CANCELLED,
          }),
        ],
        badge: null,
      },
      {
        name: "shows no badge for an empty list",
        requests: [],
        badge: null,
      },
    ];

    it.each(COUNT_CASES)("$name", async ({ requests, badge }) => {
      serveData(requests);

      await updatePendingBorrowBadge(button);

      expect(getBadge()?.textContent ?? null).toBe(badge);
      // A fully valid payload must not emit any sanitizer warning.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("removes a stale badge when the fresh count is zero", async () => {
      seedStaleBadge();
      serveData([makeBorrowRequest({ ownerId: OTHER_ID })]);

      await updatePendingBorrowBadge(button);

      expect(getBadge()).toBeNull();
    });

    it("replaces an existing badge with the fresh count", async () => {
      seedStaleBadge();
      serveData([
        makeBorrowRequest({ requestId: "req-1" }),
        makeBorrowRequest({ requestId: "req-2" }),
      ]);

      await updatePendingBorrowBadge(button);

      expect(button.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
      expect(getBadge()?.textContent).toBe("2");
    });
  });

  describe("malformed envelope", () => {
    // Each case seeds a stale badge first: a hostile envelope must still reach
    // updateBadge(0) and clear it, never blow up into the outer catch.
    const ENVELOPE_CASES: Array<{ name: string; json: unknown }> = [
      { name: "the body is null", json: null },
      { name: "the body is a string", json: "[]" },
      { name: "the body is a number", json: 42 },
      { name: "the body is a boolean", json: true },
      { name: "the body is a bare array", json: [] },
      { name: "the object carries no data key", json: {} },
      {
        name: "the object wraps the list under another key",
        json: { requests: [] },
      },
      { name: "data is an object", json: { data: {} } },
      { name: "data is a string", json: { data: "[]" } },
      { name: "data is null", json: { data: null } },
      { name: "data is a number", json: { data: 7 } },
    ];

    it.each(ENVELOPE_CASES)(
      "shows no badge and does not throw when $name",
      async ({ json }) => {
        seedStaleBadge();
        serveJson(json);

        await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

        expect(getBadge()).toBeNull();
        // The sanitizer degrades a non-array to [] with one aggregate warning.
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[borrowValidation]"),
        );
      },
    );
  });

  describe("malformed elements", () => {
    // Every case mixes ONE valid pending+owned element among hostile ones, so a
    // green result proves the sanitize→filter→badge wiring, not just that the
    // call survived.
    const ELEMENT_CASES: Array<{ name: string; element: unknown }> = [
      { name: "null", element: null },
      { name: "undefined", element: undefined },
      { name: "a string primitive", element: "req-x" },
      { name: "a number primitive", element: 42 },
      { name: "an array", element: [makeBorrowRequest()] },
      {
        name: "an object with no requestId",
        element: { ownerId: OWNER_ID, status: BorrowStatus.PENDING },
      },
      {
        name: "an object with an empty-string requestId",
        element: {
          ...makeBorrowRequest({ requestId: "req-empty" }),
          requestId: "",
        },
      },
      {
        name: "an object with a numeric requestId",
        element: { ...makeBorrowRequest(), requestId: 7 },
      },
    ];

    it.each(ELEMENT_CASES)(
      "drops an element that is $name and still counts the valid sibling",
      async ({ element }) => {
        serveData([element, makeBorrowRequest({ requestId: "req-valid" })]);

        await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

        expect(getBadge()?.textContent).toBe("1");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 1"),
        );
      },
    );

    it("does not count an element whose ownerId is not a string", async () => {
      // The sanitizer normalizes a non-string ownerId to "" — which can never
      // equal the stored userId (an empty userId returns before the fetch), so
      // a hostile element cannot forge a pending count.
      serveData([
        { ...makeBorrowRequest({ requestId: "req-hostile" }), ownerId: 42 },
        {
          ...makeBorrowRequest({ requestId: "req-hostile-2" }),
          ownerId: { id: OWNER_ID },
        },
      ]);

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(getBadge()).toBeNull();
    });

    it("does not crash the filter on non-string status values", async () => {
      // `status` passes through the sanitizer unvalidated by design; the
      // `=== BorrowStatus.PENDING` comparison must simply not match.
      serveData([
        { ...makeBorrowRequest({ requestId: "req-1" }), status: "PENDING" },
        { ...makeBorrowRequest({ requestId: "req-2" }), status: { code: 0 } },
        { ...makeBorrowRequest({ requestId: "req-3" }), status: null },
        { ...makeBorrowRequest({ requestId: "req-4" }), status: undefined },
        makeBorrowRequest({ requestId: "req-valid" }),
      ]);

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(getBadge()?.textContent).toBe("1");
    });

    it("clears a stale badge when every element is malformed", async () => {
      seedStaleBadge();
      serveData([null, "nope", { requestId: "" }]);

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(getBadge()).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("dropped 3"),
      );
    });
  });

  describe("request shape", () => {
    it("sends a Bearer-authorized request to the family borrow endpoint", async () => {
      await updatePendingBorrowBadge(button);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${ENDPOINT}/api/family/${FAMILY_ID}/borrow`);
      expect(init.headers).toEqual({ Authorization: `Bearer ${AUTH_TOKEN}` });
    });

    it("trims trailing slashes from the stored endpoint", async () => {
      await seedStorage({
        ...storageWithout(),
        [API_ENDPOINT_KEY]: `${ENDPOINT}///`,
      });

      await updatePendingBorrowBadge(button);

      expect(fetchSpy.mock.calls[0][0]).toBe(
        `${ENDPOINT}/api/family/${FAMILY_ID}/borrow`,
      );
    });

    it("falls back to the default endpoint when none is stored", async () => {
      await seedStorage(storageWithout(API_ENDPOINT_KEY));

      await updatePendingBorrowBadge(button);

      // DEFAULT_API_ENDPOINT is canonicalized at definition; production applies
      // the same trailing-slash trim before appending the path.
      expect(fetchSpy.mock.calls[0][0]).toBe(
        `${DEFAULT_API_ENDPOINT.replace(/\/+$/, "")}/api/family/${FAMILY_ID}/borrow`,
      );
    });

    it("percent-encodes the family id into the path", async () => {
      await seedStorage({
        ...storageWithout(),
        [FAMILY_ID_KEY]: "fam/../evil",
      });

      await updatePendingBorrowBadge(button);

      expect(fetchSpy.mock.calls[0][0]).toBe(
        `${ENDPOINT}/api/family/fam%2F..%2Fevil/borrow`,
      );
    });
  });

  describe("early return before any request", () => {
    const MISSING_CASES: Array<{
      name: string;
      stored: Record<string, unknown>;
    }> = [
      { name: "no userId is stored", stored: storageWithout(USER_ID_KEY) },
      { name: "no familyId is stored", stored: storageWithout(FAMILY_ID_KEY) },
      {
        name: "no auth token is stored",
        stored: storageWithout(AUTH_TOKEN_KEY),
      },
      { name: "storage is entirely empty", stored: {} },
      {
        name: "the stored userId is an empty string",
        stored: { ...storageWithout(), [USER_ID_KEY]: "" },
      },
      {
        name: "the stored auth token is an empty string",
        stored: { ...storageWithout(), [AUTH_TOKEN_KEY]: "" },
      },
    ];

    it.each(MISSING_CASES)("never fetches when $name", async ({ stored }) => {
      await seedStorage(stored);

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getBadge()).toBeNull();
    });
  });

  describe("failure paths", () => {
    it("does not read the body when the response is not ok", async () => {
      const jsonSpy = serveJson({ data: [makeBorrowRequest()] }, false);

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(jsonSpy).not.toHaveBeenCalled();
      expect(getBadge()).toBeNull();
    });

    it("resolves without throwing when fetch rejects", async () => {
      fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(getBadge()).toBeNull();
    });

    it("resolves without throwing when the body is not valid JSON", async () => {
      const jsonSpy = vi
        .fn()
        .mockRejectedValue(new SyntaxError("Unexpected <"));
      fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jsonSpy,
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(jsonSpy).toHaveBeenCalledTimes(1);
      expect(getBadge()).toBeNull();
    });

    it("resolves without fetching when storage reads reject", async () => {
      storageGet.mockRejectedValueOnce(
        new Error("extension context invalidated"),
      );

      await expect(updatePendingBorrowBadge(button)).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getBadge()).toBeNull();
    });
  });
});
