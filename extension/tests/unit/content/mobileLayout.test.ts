import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  watchMobile,
  stopAllMobileWatchers,
  applyDialogLayout,
  applyBackdropLayout,
  createCloseIcon,
  placeFloatingButton,
} from "@/content/mobileLayout";
import { SHELL_BOOTSTRAP_CSS } from "@/content/shellStyles";
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

    it("sets a fixed 80vh height for the desktop main view", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, false, true);
      expect(dialog.style.height).toBe("80vh");
      expect(dialog.style.maxHeight).toBe("80vh");
      expect(dialog.style.maxWidth).toBe("640px");
      expect(dialog.style.borderRadius).toBe("12px");
    });

    it("omits a fixed height for desktop non-main views (default)", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, false);
      expect(dialog.style.height).toBe("");
      // Remaining desktop card styles keep it centred and height-capped.
      expect(dialog.style.maxHeight).toBe("80vh");
      expect(dialog.style.maxWidth).toBe("640px");
      expect(dialog.style.borderRadius).toBe("12px");
    });

    it("clears the fixed height when switching from main to a non-main view", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, false, true);
      expect(dialog.style.height).toBe("80vh");
      applyDialogLayout(dialog, false, false);
      expect(dialog.style.height).toBe("");
    });

    it("keeps full-screen height on mobile regardless of the view", () => {
      const dialog = document.createElement("div");
      applyDialogLayout(dialog, true, true);
      expect(dialog.style.height).toBe("100vh");
      applyDialogLayout(dialog, true, false);
      expect(dialog.style.height).toBe("100vh");
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
      // The static 32px size moved from inline cssText to the `.moo-shell-close`
      // class in SHELL_BOOTSTRAP_CSS (injected into the shadow root). jsdom does
      // not reflect stylesheet rules onto `.style`, so the class is now the
      // observable contract for the size — assert the class here and pin the
      // actual px value against the source stylesheet below.
      expect(btn.classList.contains("moo-shell-close")).toBe(true);
      expect(SHELL_BOOTSTRAP_CSS).toMatch(/\.moo-shell-close\s*\{[^}]*width:\s*32px/);
      expect(SHELL_BOOTSTRAP_CSS).toMatch(/\.moo-shell-close\s*\{[^}]*height:\s*32px/);
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
    const GAP_PX = 12;
    const FALLBACK_HEIGHT_PX = 55;
    const FALLBACK_HEIGHT_SMALL_PX = 76;
    const SMALL_PHONE_BREAKPOINT_PX = 370;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;

    function makeButton(): HTMLElement {
      const btn = document.createElement("button");
      document.body.appendChild(btn);
      return btn;
    }

    function setViewport(width: number, height: number): void {
      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: height,
        configurable: true,
        writable: true,
      });
    }

    function rect(partial: Partial<DOMRect>): DOMRect {
      return {
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
        ...partial,
      } as DOMRect;
    }

    /** Append a bottom-nav element and stub its rect so it reads as a bottom bar. */
    function addBottomNav(navRect: Partial<DOMRect>): HTMLElement {
      const nav = document.createElement("nav");
      nav.className = "bottom-nav";
      document.body.appendChild(nav);
      vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(navRect));
      return nav;
    }

    /**
     * Append Readmoo's real bottom bar as a `div.main-menu` and stub its rect so
     * it reads as a bottom bar. The class is exactly `main-menu` (no
     * `nav nav-justified`) so ONLY the new `.main-menu` selector can match it —
     * none of the pre-existing selectors (`.bottom-nav`, `nav[class*='bottom']`,
     * `footer nav`, …) do — which isolates the `.main-menu` path.
     */
    function addMainMenuBar(barRect: Partial<DOMRect>): HTMLElement {
      const bar = document.createElement("div");
      bar.className = "main-menu";
      document.body.appendChild(bar);
      vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect(barRect));
      return bar;
    }

    /**
     * Append Readmoo's bottom bar matched ONLY by the `.nav.nav-justified`
     * selector and stub its rect so it reads as a bottom bar. The class is
     * exactly `nav nav-justified` (NO `main-menu`) so the leading `.main-menu`
     * selector cannot match it — reaching a measured height can only happen via
     * the `.nav.nav-justified` entry in the allowlist. This isolates that line so
     * removing it from the production selector list breaks this test.
     */
    function addNavJustifiedBar(barRect: Partial<DOMRect>): HTMLElement {
      const bar = document.createElement("div");
      bar.className = "nav nav-justified";
      document.body.appendChild(bar);
      vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect(barRect));
      return bar;
    }

    afterEach(() => {
      setViewport(originalInnerWidth, originalInnerHeight);
    });

    it("uses bottom-right placement on desktop with original offsets", () => {
      const btn = makeButton();
      const measured = placeFloatingButton(btn, false);
      expect(measured).toBe(false);
      expect(btn.style.bottom).toBe("24px");
      expect(btn.style.right).toBe("24px");
      expect(btn.style.top).toBe("auto");
      expect(btn.style.left).toBe("auto");
    });

    it("lifts the button above the measured bottom nav on mobile", () => {
      setViewport(400, 800);
      const navHeight = 55;
      // Bottom bar: full width, bottom edge flush with the viewport bottom.
      addBottomNav({
        width: 400,
        height: navHeight,
        bottom: 800,
        top: 800 - navHeight,
      });

      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(true);
      expect(btn.style.right).toBe("24px");
      expect(btn.style.top).toBe("auto");
      expect(btn.style.bottom).toBe(`${navHeight + GAP_PX}px`);
    });

    it("adapts to a taller two-line bottom nav when measured", () => {
      setViewport(360, 800);
      const navHeight = 76;
      addBottomNav({
        width: 360,
        height: navHeight,
        bottom: 800,
        top: 800 - navHeight,
      });

      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(true);
      expect(btn.style.bottom).toBe(`${navHeight + GAP_PX}px`);
    });

    it("falls back to 55px on mobile when no nav is found (width > 370)", () => {
      setViewport(400, 800);
      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(false);
      expect(btn.style.right).toBe("24px");
      expect(btn.style.bottom).toBe(`${FALLBACK_HEIGHT_PX + GAP_PX}px`);
    });

    it("falls back to 76px on mobile when no nav is found (width <= 370)", () => {
      setViewport(SMALL_PHONE_BREAKPOINT_PX, 800);
      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(false);
      expect(btn.style.bottom).toBe(`${FALLBACK_HEIGHT_SMALL_PX + GAP_PX}px`);
    });

    it("ignores a candidate that does not span the viewport width", () => {
      setViewport(400, 800);
      // Narrow element flush with the bottom: spans only 30% of width, so it is
      // not a bottom bar and the width fallback (55px) must be used instead.
      addBottomNav({ width: 120, height: 40, bottom: 800, top: 760 });

      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(false);
      expect(btn.style.bottom).toBe(`${FALLBACK_HEIGHT_PX + GAP_PX}px`);
    });

    it("ignores a full-width candidate that is not at the viewport bottom", () => {
      setViewport(400, 800);
      // Full width but anchored at the top (a header), not the bottom bar.
      addBottomNav({ width: 400, height: 55, bottom: 55, top: 0 });

      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(false);
      expect(btn.style.bottom).toBe(`${FALLBACK_HEIGHT_PX + GAP_PX}px`);
    });

    it("matches Readmoo's real .main-menu div as the bottom bar (measured, not fallback)", () => {
      setViewport(400, 800);
      // Height 60 is deliberately distinct from every fallback path so the
      // assertion proves a MEASURED value, not a tautology:
      //   measured  -> 60 + 12 = 72px
      //   fallback  -> 55 + 12 = 67px (width > 370) | 76 + 12 = 88px (width <= 370)
      // Only a div.main-menu (no `.bottom-nav`, no `nav[class*='bottom']`) is
      // present, so reaching 72px can only happen via the new `.main-menu`
      // selector at the front of the allowlist.
      const barHeight = 60;
      addMainMenuBar({
        width: 400,
        height: barHeight,
        bottom: 800,
        top: 800 - barHeight,
      });

      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(true);
      expect(btn.style.bottom).toBe(`${barHeight + GAP_PX}px`);
    });

    it("matches the .nav.nav-justified bottom bar (measured, not fallback)", () => {
      setViewport(400, 800);
      // Height 67 is deliberately distinct from every fallback path so the
      // assertion proves a MEASURED value, not a tautology:
      //   measured  -> 67 + 12 = 79px
      //   fallback  -> 55 + 12 = 67px (width > 370) | 76 + 12 = 88px (width <= 370)
      // (67 is used as the HEIGHT here; it differs from the 76px small-phone
      // fallback height, and the resulting 79px offset matches no fallback.)
      // Only a div.nav.nav-justified (NO `.main-menu`) is present, so reaching
      // 79px can only happen via the `.nav.nav-justified` selector — removing
      // that line from the production allowlist makes this test fail.
      const barHeight = 67;
      addNavJustifiedBar({
        width: 400,
        height: barHeight,
        bottom: 800,
        top: 800 - barHeight,
      });

      const btn = makeButton();
      const measured = placeFloatingButton(btn, true);
      expect(measured).toBe(true);
      expect(btn.style.bottom).toBe(`${barHeight + GAP_PX}px`);
    });
  });
});
