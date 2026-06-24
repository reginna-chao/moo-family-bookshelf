import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  watchMobile,
  stopAllMobileWatchers,
  applyDialogLayout,
  applyBackdropLayout,
  createCloseIcon,
  placeFloatingButton,
} from "@/content/mobileLayout";
import { MOBILE_MEDIA_QUERY } from "@/hooks/breakpoints";

type ChangeListener = () => void;

interface MockMql {
  matches: boolean;
  media: string;
  _listeners: Set<ChangeListener>;
  _setMatches: (v: boolean) => void;
  addEventListener: (type: string, cb: EventListenerOrEventListenerObject | null) => void;
  removeEventListener: (type: string, cb: EventListenerOrEventListenerObject | null) => void;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

function createMockMql(query: string, matches: boolean): MockMql {
  const listeners = new Set<ChangeListener>();
  const mql: MockMql = {
    matches,
    media: query,
    _listeners: listeners,
    _setMatches(v: boolean) {
      mql.matches = v;
      listeners.forEach((cb) => cb());
    },
    addEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
      if (type === "change" && typeof cb === "function") listeners.add(cb as ChangeListener);
    },
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
      if (type === "change" && typeof cb === "function") listeners.delete(cb as ChangeListener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  return mql;
}

describe("mobileLayout", () => {
  let mql: MockMql;

  beforeEach(() => {
    mql = createMockMql(MOBILE_MEDIA_QUERY, false);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        // Only the mobile query is exercised; return the shared mock for it.
        if (query === MOBILE_MEDIA_QUERY) return mql;
        return createMockMql(query, false);
      }),
    );
    window.matchMedia = globalThis.matchMedia;
  });

  afterEach(() => {
    stopAllMobileWatchers();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("watchMobile", () => {
    it("invokes the callback immediately with the current match state", () => {
      mql._setMatches(true);
      const onChange = vi.fn();
      watchMobile(onChange);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("invokes the callback again when the breakpoint changes", () => {
      const onChange = vi.fn();
      watchMobile(onChange);
      onChange.mockClear();

      mql._setMatches(true);
      expect(onChange).toHaveBeenCalledWith(true);

      mql._setMatches(false);
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it("registers a change listener on the media query list", () => {
      watchMobile(vi.fn());
      expect(mql._listeners.size).toBe(1);
    });

    it("removes the listener when the returned disposer is called", () => {
      const dispose = watchMobile(vi.fn());
      expect(mql._listeners.size).toBe(1);
      dispose();
      expect(mql._listeners.size).toBe(0);
    });

    it("stops firing the callback after disposal", () => {
      const onChange = vi.fn();
      const dispose = watchMobile(onChange);
      dispose();
      onChange.mockClear();
      mql._setMatches(true);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("stopAllMobileWatchers", () => {
    it("removes every registered listener", () => {
      watchMobile(vi.fn());
      watchMobile(vi.fn());
      expect(mql._listeners.size).toBe(2);
      stopAllMobileWatchers();
      expect(mql._listeners.size).toBe(0);
    });

    it("is safe to call when no watchers exist", () => {
      expect(() => stopAllMobileWatchers()).not.toThrow();
    });
  });

  describe("applyDialogLayout", () => {
    it("applies full-screen styles on mobile", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, true);
      expect(dialog.style.width).toBe("100vw");
      expect(dialog.style.maxHeight).toBe("100vh");
      expect(dialog.style.borderRadius).toBe("0");
      expect(dialog.style.transform).toBe("none");
      expect(dialog.style.top).toBe("0px");
      expect(dialog.style.left).toBe("0px");
    });

    it("applies centred-card styles on desktop", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, false);
      expect(dialog.style.width).toBe("90vw");
      expect(dialog.style.maxWidth).toBe("640px");
      expect(dialog.style.maxHeight).toBe("80vh");
      expect(dialog.style.borderRadius).toBe("12px");
      expect(dialog.style.transform).toBe("translate(-50%, -50%)");
    });

    it("restores desktop layout after a mobile pass", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, true);
      applyDialogLayout(dialog, false);
      expect(dialog.style.width).toBe("90vw");
      expect(dialog.style.borderRadius).toBe("12px");
      expect(dialog.style.transform).toBe("translate(-50%, -50%)");
    });
  });

  describe("applyBackdropLayout", () => {
    it("hides the backdrop on mobile", () => {
      const backdrop = document.createElement("div");
      applyBackdropLayout(backdrop, true);
      expect(backdrop.style.display).toBe("none");
    });

    it("shows the backdrop on desktop", () => {
      const backdrop = document.createElement("div");
      applyBackdropLayout(backdrop, false);
      expect(backdrop.style.display).toBe("block");
    });
  });

  describe("createCloseIcon", () => {
    it("is visible on mobile and hidden on desktop", () => {
      const mobileBtn = createCloseIcon(vi.fn(), true);
      expect(mobileBtn.style.display).toBe("inline-flex");

      const desktopBtn = createCloseIcon(vi.fn(), false);
      expect(desktopBtn.style.display).toBe("none");
    });

    it("is a 32px touch target with an accessible label", () => {
      const btn = createCloseIcon(vi.fn(), true);
      expect(btn.style.width).toBe("32px");
      expect(btn.style.height).toBe("32px");
      expect(btn.getAttribute("aria-label")).toBe("關閉");
    });

    it("reuses the provided close handler on click", () => {
      const onClose = vi.fn();
      const btn = createCloseIcon(onClose, true);
      btn.click();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("placeFloatingButton", () => {
    function makeButton(): HTMLElement {
      const btn = document.createElement("button");
      document.body.appendChild(btn);
      return btn;
    }

    it("uses bottom-right placement on desktop", () => {
      const btn = makeButton();
      const usedAnchor = placeFloatingButton(btn, false);
      expect(usedAnchor).toBe(false);
      expect(btn.style.bottom).toBe("24px");
      expect(btn.style.right).toBe("24px");
      expect(btn.style.top).toBe("auto");
    });

    it("falls back to bottom-right on mobile when no header anchor exists", () => {
      const btn = makeButton();
      const usedAnchor = placeFloatingButton(btn, true);
      expect(usedAnchor).toBe(false);
      expect(btn.style.bottom).toBe("24px");
      expect(btn.style.right).toBe("24px");
    });

    it("relocates next to the Readmoo header overflow button on mobile", () => {
      const header = document.createElement("header");
      const overflow = document.createElement("button");
      overflow.className = "header-overflow";
      overflow.setAttribute("aria-haspopup", "true");
      header.appendChild(overflow);
      document.body.appendChild(header);

      // jsdom returns zero rects by default; stub a non-zero rect so the
      // anchor is considered visible and usable.
      vi.spyOn(overflow, "getBoundingClientRect").mockReturnValue({
        top: 10,
        left: 300,
        right: 332,
        bottom: 42,
        width: 32,
        height: 32,
        x: 300,
        y: 10,
        toJSON: () => ({}),
      } as DOMRect);

      const btn = makeButton();
      const usedAnchor = placeFloatingButton(btn, true);
      expect(usedAnchor).toBe(true);
      expect(btn.style.bottom).toBe("auto");
      expect(btn.style.top).toBe("10px");
      // right = innerWidth - anchor.left + gap
      const expectedRight = window.innerWidth - 300 + 8;
      expect(btn.style.right).toBe(`${expectedRight}px`);
    });

    it("does not match a generic 'overflow-hidden' utility class on mobile", () => {
      const header = document.createElement("header");
      const util = document.createElement("div");
      // Generic utility class: substring contains "overflow" but is NOT a
      // standalone `overflow` token, and there is no aria-haspopup / aria-label
      // menu trigger. Must not be matched by the [class~='overflow'] selector.
      util.className = "overflow-hidden";
      header.appendChild(util);
      document.body.appendChild(header);

      vi.spyOn(util, "getBoundingClientRect").mockReturnValue({
        top: 10,
        left: 300,
        right: 332,
        bottom: 42,
        width: 32,
        height: 32,
        x: 300,
        y: 10,
        toJSON: () => ({}),
      } as DOMRect);

      const btn = makeButton();
      const usedAnchor = placeFloatingButton(btn, true);
      expect(usedAnchor).toBe(false);
      expect(btn.style.bottom).toBe("24px");
      expect(btn.style.right).toBe("24px");
    });

    it("matches a standalone 'overflow' class token on mobile", () => {
      const header = document.createElement("header");
      const overflow = document.createElement("div");
      // Standalone `overflow` token (no aria-haspopup), so it can only be
      // reached via the [class~='overflow'] selector, not the button selector.
      overflow.className = "header overflow";
      header.appendChild(overflow);
      document.body.appendChild(header);

      vi.spyOn(overflow, "getBoundingClientRect").mockReturnValue({
        top: 10,
        left: 300,
        right: 332,
        bottom: 42,
        width: 32,
        height: 32,
        x: 300,
        y: 10,
        toJSON: () => ({}),
      } as DOMRect);

      const btn = makeButton();
      const usedAnchor = placeFloatingButton(btn, true);
      expect(usedAnchor).toBe(true);
      expect(btn.style.bottom).toBe("auto");
      expect(btn.style.top).toBe("10px");
    });
  });
});
