import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTR_LIST_TOTAL } from "@/content/fiber-data";

/**
 * Main-world fiber bridge (`src/content/fiber-bridge.ts`), list-total half
 * (#236 F1). On `moo-request-fiber-data` it publishes Readmoo's
 * `filteredItemList.length` — found by walking `fiber.return` from the first
 * `.library-item` (else from `.books .row`) — as `data-moo-list-total` on
 * `<html>`, removes the attribute whenever that cannot be read, and always
 * answers with `moo-fiber-data`.
 *
 * The module registers its listener at import time and exposes no teardown, so
 * it is imported ONCE for this file (Vitest isolates each test file's
 * environment); every case resets the DOM and the attribute.
 */

interface FakeFiber {
  memoizedProps?: Record<string, unknown>;
  return: FakeFiber | null;
}

const root = document.documentElement;
let fiberDataEvents = 0;
const countFiberData = () => {
  fiberDataEvents++;
};

/** Attach `fiber` to `el` the way React does (an own `__reactFiber$…` key). */
function attachFiber(el: Element, fiber: unknown): void {
  Object.defineProperty(el, "__reactFiber$test", {
    value: fiber,
    enumerable: true,
    configurable: true,
  });
}

/** `depth` prop-less fibers, then `top` (or the end of the chain). */
function chain(depth: number, top: FakeFiber | null): FakeFiber | null {
  let fiber = top;
  for (let i = 0; i < depth; i++) fiber = { memoizedProps: {}, return: fiber };
  return fiber;
}

function host(list: unknown): FakeFiber {
  return { memoizedProps: { filteredItemList: list }, return: null };
}

function mountCard(childFiber: unknown): HTMLElement {
  const card = document.createElement("div");
  card.className = "library-item";
  card.innerHTML = `<div class="info"><span class="title" title="書">書</span></div>`;
  document.body.appendChild(card);
  const span = card.querySelector(".title");
  if (!span) throw new Error("fixture missing .title");
  attachFiber(span, childFiber);
  return card;
}

function request(): void {
  document.dispatchEvent(new CustomEvent("moo-request-fiber-data"));
}

beforeAll(async () => {
  await import("@/content/fiber-bridge");
});

beforeEach(() => {
  document.body.innerHTML = "";
  root.removeAttribute(ATTR_LIST_TOTAL);
  fiberDataEvents = 0;
  document.addEventListener("moo-fiber-data", countFiberData);
});

afterEach(() => {
  document.removeEventListener("moo-fiber-data", countFiberData);
  document.body.innerHTML = "";
  root.removeAttribute(ATTR_LIST_TOTAL);
});

describe("fiber-bridge list total", () => {
  it("publishes filteredItemList.length of the host above the first card, and stamps the card", () => {
    const bookFiber: FakeFiber = {
      memoizedProps: { libraryItem: { book: { id: "210439468000301" } } },
      return: chain(6, host([1, 2, 3])),
    };
    const card = mountCard({ memoizedProps: {}, return: bookFiber });

    request();

    expect(root.getAttribute(ATTR_LIST_TOTAL)).toBe("3");
    expect(card.getAttribute("data-moo-book-id")).toBe("210439468000301");
    expect(fiberDataEvents).toBe(1);
  });

  it("uses the FIRST card's host when several cards exist", () => {
    mountCard(chain(2, host(new Array(7).fill(0))));
    mountCard(chain(2, host([1])));

    request();

    expect(root.getAttribute(ATTR_LIST_TOTAL)).toBe("7");
  });

  it("starts from `.books .row` when no card is rendered (an empty filter)", () => {
    document.body.innerHTML = `<div class="books"><div class="row"></div></div>`;
    const row = document.querySelector(".books .row");
    if (!row) throw new Error("fixture missing .books .row");
    attachFiber(row, chain(3, host([])));

    request();

    expect(root.getAttribute(ATTR_LIST_TOTAL)).toBe("0");
    expect(fiberDataEvents).toBe(1);
  });

  it.each([
    { name: "39 hops (inside the bound)", depth: 39, expected: "2" },
    { name: "40 hops (past the bound)", depth: 40, expected: null },
  ])("finds the host at $name → $expected", ({ depth, expected }) => {
    mountCard(chain(depth, host([1, 2])));

    request();

    expect(root.getAttribute(ATTR_LIST_TOTAL)).toBe(expected);
  });

  describe("removes the attribute (a stale value never survives)", () => {
    beforeEach(() => {
      root.setAttribute(ATTR_LIST_TOTAL, "9");
    });

    it("when nothing to start from is on the page", () => {
      request();

      expect(root.hasAttribute(ATTR_LIST_TOTAL)).toBe(false);
      expect(fiberDataEvents).toBe(1);
    });

    it("when the card carries no React fiber at all", () => {
      document.body.innerHTML = `<div class="library-item"><span>書</span></div>`;

      request();

      expect(root.hasAttribute(ATTR_LIST_TOTAL)).toBe(false);
    });

    it("when no ancestor holds filteredItemList", () => {
      mountCard(chain(5, null));

      request();

      expect(root.hasAttribute(ATTR_LIST_TOTAL)).toBe(false);
    });

    it.each([
      { name: "an array-like object", list: { length: 5 } },
      { name: "a number", list: 5 },
      { name: "null", list: null },
    ])("when filteredItemList is $name, not an array", ({ list }) => {
      mountCard(chain(2, host(list)));

      request();

      expect(root.hasAttribute(ATTR_LIST_TOTAL)).toBe(false);
    });

    it("when walking the fibers throws, and still answers moo-fiber-data", () => {
      const throwing = {
        get memoizedProps(): never {
          throw new Error("hostile fiber");
        },
        return: null,
      };
      mountCard(throwing);

      expect(() => request()).not.toThrow();
      expect(root.hasAttribute(ATTR_LIST_TOTAL)).toBe(false);
      expect(fiberDataEvents).toBe(1);
    });
  });

  it("still publishes the total and answers when stamping a card throws", () => {
    // The card's OWN fiber leads to the host (the total path); its child's
    // fiber throws (the stamping path walks descendants only).
    const card = mountCard({
      get memoizedProps(): never {
        throw new Error("hostile fiber");
      },
      return: null,
    });
    attachFiber(card, chain(1, host([1, 2])));

    expect(() => request()).not.toThrow();
    expect(root.getAttribute(ATTR_LIST_TOTAL)).toBe("2");
    expect(card.hasAttribute("data-moo-book-id")).toBe(false);
    expect(fiberDataEvents).toBe(1);
  });
});
