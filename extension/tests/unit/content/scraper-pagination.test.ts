import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  paginateLibrary,
  formatScrapeProgress,
} from "@/content/scraper-pagination";

function addLibraryItems(count: number): void {
  for (let i = 0; i < count; i++) {
    const div = document.createElement("div");
    div.className = "library-item";
    document.body.appendChild(div);
  }
}

function setScrollable(scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
}

describe("formatScrapeProgress", () => {
  it.each([
    [1, 200, "正在讀取第 1 頁，已收集 200 本…"],
    [5, 1000, "正在讀取第 5 頁，已收集 1000 本…"],
    [100, 20000, "正在讀取第 100 頁，已收集 20000 本…"],
  ])("formats page=%i count=%i correctly", (page, count, expected) => {
    expect(formatScrapeProgress(page, count)).toBe(expected);
  });

  it("uses fullwidth comma and U+2026 ellipsis", () => {
    const msg = formatScrapeProgress(1, 1);
    expect(msg).toContain("，");
    expect(msg).toContain("…");
    expect(msg).not.toContain("...");
  });
});

describe("paginateLibrary", () => {
  let scrollToSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    // Restore layout properties to jsdom defaults
    Object.defineProperty(document.documentElement, "scrollHeight", {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 0,
      configurable: true,
    });
  });

  it("returns immediately when page is not scrollable (jsdom default)", async () => {
    addLibraryItems(5);
    const onProgress = vi.fn();

    await paginateLibrary(onProgress);

    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("returns without error when no items grow after scrolling", async () => {
    setScrollable(5000, 800);
    addLibraryItems(200);
    const onProgress = vi.fn();

    const promise = paginateLibrary(onProgress);
    // Advance past the full 10s timeout (20 poll cycles × 500ms)
    for (let i = 0; i < 22; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await promise;

    expect(scrollToSpy).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("paginates through multiple pages and calls onProgress", async () => {
    setScrollable(5000, 800);
    addLibraryItems(200);

    let scrollCount = 0;
    scrollToSpy.mockImplementation(() => {
      scrollCount++;
      if (scrollCount <= 3) addLibraryItems(200);
    });

    const onProgress = vi.fn();
    const promise = paginateLibrary(onProgress);

    // Pages 1-3: each needs one 500ms poll cycle to detect growth
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    // Page 4: scrollTo does nothing, wait times out
    for (let i = 0; i < 22; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await promise;

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 400);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 600);
    expect(onProgress).toHaveBeenNthCalledWith(3, 3, 800);
  });

  it("exits when growth stops after a successful page", async () => {
    setScrollable(5000, 800);
    addLibraryItems(200);

    // Only add items on first scroll
    let added = false;
    scrollToSpy.mockImplementation(() => {
      if (!added) {
        addLibraryItems(200);
        added = true;
      }
    });

    const onProgress = vi.fn();
    const promise = paginateLibrary(onProgress);

    // Page 1: growth detected
    await vi.advanceTimersByTimeAsync(500);
    // Page 2: scrollTo no-op, wait times out
    for (let i = 0; i < 22; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await promise;

    // Page 1 grows; page 2 has no growth, exits via !grew
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(1, 400);
  });

  it("stops at hard cap of 100 pages and logs a warning", async () => {
    setScrollable(5000, 800);
    addLibraryItems(1);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Every scroll adds 1 item (infinite growth)
    scrollToSpy.mockImplementation(() => addLibraryItems(1));

    const onProgress = vi.fn();
    const promise = paginateLibrary(onProgress);

    // 100 pages, each needs 1 poll cycle (500ms)
    for (let i = 0; i < 100; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await promise;

    expect(onProgress).toHaveBeenCalledTimes(100);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("hard cap"),
    );
  });

  it("runs without error when onProgress is not provided", async () => {
    setScrollable(5000, 800);
    addLibraryItems(200);

    // Only add items on first scroll, then stop
    scrollToSpy.mockImplementationOnce(() => addLibraryItems(200));

    const promise = paginateLibrary();

    // Page 1: growth detected
    await vi.advanceTimersByTimeAsync(500);
    // Page 2: no growth, wait times out
    for (let i = 0; i < 22; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await promise;

    expect(scrollToSpy).toHaveBeenCalled();
  });

  it("returns immediately when zero items exist and page is not scrollable", async () => {
    const onProgress = vi.fn();
    await paginateLibrary(onProgress);

    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });
});
