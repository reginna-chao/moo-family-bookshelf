import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ATTR_LIBRARY_IDS,
  ATTR_LIST_TOTAL,
  requestLibraryFiberData,
  requestLibraryListTotal,
} from "@/content/fiber-data";

/**
 * `requestLibraryListTotal` (#236 F1): reads the list total the main-world
 * bridge publishes on `<html>`. Only a well-formed, safe, non-negative integer
 * written in answer to THIS request counts; anything else is `null` (unknown),
 * which makes the scrape incomplete.
 *
 * `requestLibraryFiberData` (#241): one bridge request that reads the list
 * total AND the account's library ids (`data-moo-library-ids`, comma-joined).
 * Both attributes are cleared before the request, so a bridge that never
 * answers yields null for each. An absent ids attribute is null (unknown, no
 * pruning); `""` is a known-empty library (an empty set); only real 12+ digit
 * ids survive, since the set is matched against real saved ids.
 */

const root = document.documentElement;
let cleanupResponder: (() => void) | null = null;

/** A bridge stand-in: runs `onRequest`, then signals completion. */
function installResponder(onRequest: () => void): void {
  const handler = () => {
    onRequest();
    document.dispatchEvent(new CustomEvent("moo-fiber-data"));
  };
  document.addEventListener("moo-request-fiber-data", handler);
  cleanupResponder = () =>
    document.removeEventListener("moo-request-fiber-data", handler);
}

beforeEach(() => {
  // Bridge already injected → no script load wait.
  root.setAttribute("data-moo-fiber-bridge", "1");
  root.removeAttribute(ATTR_LIST_TOTAL);
  root.removeAttribute(ATTR_LIBRARY_IDS);
});

afterEach(() => {
  cleanupResponder?.();
  cleanupResponder = null;
  vi.useRealTimers();
  root.removeAttribute("data-moo-fiber-bridge");
  root.removeAttribute(ATTR_LIST_TOTAL);
  root.removeAttribute(ATTR_LIBRARY_IDS);
});

describe("ATTR_LIST_TOTAL", () => {
  it("is the attribute name the main-world bridge writes", () => {
    // Positive companion for the negative "attribute removed" assertions below.
    expect(ATTR_LIST_TOTAL).toBe("data-moo-list-total");
  });
});

describe("ATTR_LIBRARY_IDS", () => {
  it("is the attribute name the main-world bridge writes", () => {
    // fiber-bridge.ts declares its own copy (separate bundle); this pins the literal.
    expect(ATTR_LIBRARY_IDS).toBe("data-moo-library-ids");
  });
});

describe("requestLibraryFiberData", () => {
  const REAL_A = "210439468000101";
  const REAL_B = "123456789012345";

  it("clears both stale attributes before asking the bridge", async () => {
    root.setAttribute(ATTR_LIST_TOTAL, "7");
    root.setAttribute(ATTR_LIBRARY_IDS, REAL_A);
    const seen: Array<string | null> = [];
    installResponder(() => {
      seen.push(root.getAttribute(ATTR_LIST_TOTAL));
      seen.push(root.getAttribute(ATTR_LIBRARY_IDS));
    });

    const data = await requestLibraryFiberData();

    expect(seen).toEqual([null, null]);
    // The bridge answered without either attribute → both unknown, not stale.
    expect(data).toEqual({ listTotal: null, libraryIds: null });
  });

  it("returns the total and the ids written in answer to the request", async () => {
    installResponder(() => {
      root.setAttribute(ATTR_LIST_TOTAL, "2");
      root.setAttribute(ATTR_LIBRARY_IDS, `${REAL_A},${REAL_B}`);
    });

    const data = await requestLibraryFiberData();

    expect(data.listTotal).toBe(2);
    expect(data.libraryIds).toEqual(new Set([REAL_A, REAL_B]));
  });

  it.each([
    { name: "an empty attribute (a known-empty library)", raw: "", ids: [] },
    {
      name: "short ids mixed in",
      raw: `123,${REAL_A},12345678901,${REAL_B}`,
      ids: [REAL_A, REAL_B],
    },
    { name: "a duplicate id", raw: `${REAL_A},${REAL_A}`, ids: [REAL_A] },
    {
      name: "non-digit and padded entries",
      raw: `abc, ${REAL_A},${REAL_B} ,${REAL_A}x,,${REAL_B}`,
      ids: [REAL_B],
    },
  ])("reads $name as only its real ids", async ({ raw, ids }) => {
    installResponder(() => root.setAttribute(ATTR_LIBRARY_IDS, raw));

    const data = await requestLibraryFiberData();

    expect(data.libraryIds).toEqual(new Set(ids));
  });

  it("reads the ids as null when only the total was published", async () => {
    installResponder(() => root.setAttribute(ATTR_LIST_TOTAL, "4"));

    const data = await requestLibraryFiberData();

    expect(data).toEqual({ listTotal: 4, libraryIds: null });
  });

  it("returns null for both when the bridge never answers (after the request timeout)", async () => {
    vi.useFakeTimers();
    root.setAttribute(ATTR_LIST_TOTAL, "12");
    root.setAttribute(ATTR_LIBRARY_IDS, REAL_A);

    const promise = requestLibraryFiberData();
    await vi.advanceTimersByTimeAsync(2500);

    await expect(promise).resolves.toEqual({
      listTotal: null,
      libraryIds: null,
    });
  });
});

describe("requestLibraryListTotal", () => {
  it("clears a stale total before asking the bridge", async () => {
    root.setAttribute(ATTR_LIST_TOTAL, "7");
    let seenAtRequest: string | null = "unset";
    installResponder(() => {
      seenAtRequest = root.getAttribute(ATTR_LIST_TOTAL);
    });

    const total = await requestLibraryListTotal();

    expect(seenAtRequest).toBeNull();
    // The bridge answered without a total → unknown, not the stale 7.
    expect(total).toBeNull();
  });

  it.each([
    { raw: "54", expected: 54 },
    { raw: "0", expected: 0 },
    { raw: "-1", expected: null },
    { raw: "5.5", expected: null },
    { raw: "abc", expected: null },
    { raw: "", expected: null },
    { raw: " 5", expected: null },
    { raw: "1e3", expected: null },
    { raw: "9007199254740993", expected: null },
    { raw: "99999999999999999999", expected: null },
  ])("reads $raw as $expected", async ({ raw, expected }) => {
    installResponder(() => root.setAttribute(ATTR_LIST_TOTAL, raw));

    await expect(requestLibraryListTotal()).resolves.toBe(expected);
  });

  it("returns the largest safe integer as-is", async () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    installResponder(() => root.setAttribute(ATTR_LIST_TOTAL, max));

    await expect(requestLibraryListTotal()).resolves.toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("returns null when the bridge never answers (after the request timeout)", async () => {
    vi.useFakeTimers();
    root.setAttribute(ATTR_LIST_TOTAL, "12");

    const promise = requestLibraryListTotal();
    await vi.advanceTimersByTimeAsync(2500);

    await expect(promise).resolves.toBeNull();
  });
});
