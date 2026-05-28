import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mock scraper module before importing the hook
vi.mock("@/content/scraper", () => ({
  scrapeBooks: vi.fn().mockResolvedValue([
    {
      bookId: "book-1",
      title: "書一",
      author: "作者A",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
    },
    {
      bookId: "book-2",
      title: "書二",
      author: "作者B",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
    },
    {
      bookId: "book-3",
      title: "書三",
      author: "作者C",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
    },
  ]),
  scrapeArchivedBooks: vi.fn().mockResolvedValue([]),
  formatScrapeProgress: (page: number, count: number) =>
    `正在讀取第 ${page} 頁，已收集 ${count} 本…`,
}));

import { usePersonalBooks } from "@/dialog/usePersonalBooks";
import { BoolFlag, type ApiClient } from "@/api/client";

function createMockApiClient(
  overrides: Partial<ApiClient> = {},
): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderUsePersonalBooks(client?: ApiClient) {
  return renderHook(() =>
    usePersonalBooks({
      userId: "user-abc",
      apiClient: client ?? createMockApiClient(),
      lastSyncBooks: [],
      displayName: "小明",
    }),
  );
}

async function waitForReady(result: { current: { status: string } }) {
  await waitFor(() => expect(result.current.status).toBe("ready"));
}

describe("usePersonalBooks — dirty Set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with empty dirty set and isDirty=false", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it("handleToggle marks the toggled bookId as dirty", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
    });

    expect(result.current.dirtyBookIds.has("book-1")).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it("toggling the same book twice keeps it marked dirty (mark-only, no XOR)", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
    });
    act(() => {
      result.current.handleToggle("book-1");
    });

    expect(result.current.dirtyBookIds.has("book-1")).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it("markManyDirty adds multiple ids in one call", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.markManyDirty(["a", "b", "c"]);
    });

    expect(result.current.dirtyBookIds.size).toBe(3);
    expect(result.current.dirtyBookIds.has("a")).toBe(true);
    expect(result.current.dirtyBookIds.has("b")).toBe(true);
    expect(result.current.dirtyBookIds.has("c")).toBe(true);
  });

  it("markManyDirty does not duplicate existing ids", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.markManyDirty(["a"]);
    });
    act(() => {
      result.current.markManyDirty(["a", "b"]);
    });

    expect(result.current.dirtyBookIds.size).toBe(2);
    expect(result.current.dirtyBookIds.has("a")).toBe(true);
    expect(result.current.dirtyBookIds.has("b")).toBe(true);
  });

  it("markDirty returns same Set reference when bookId already present (no spurious re-render)", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.markDirty("book-1");
    });
    const firstRef = result.current.dirtyBookIds;

    act(() => {
      result.current.markDirty("book-1");
    });
    const secondRef = result.current.dirtyBookIds;

    expect(secondRef).toBe(firstRef);
  });

  it("handleSave clears the dirty set on success", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
      result.current.handleToggle("book-2");
    });
    expect(result.current.dirtyBookIds.size).toBe(2);

    // Fire handleSave; do NOT wrap in act(async), because the production code
    // schedules a 1500ms setTimeout for the "saved → ready" cleanup, and
    // act(async) waits for all pending React work to settle which would
    // hold us up for the timer. We instead poll the externally observable
    // state (dirtyBookIds cleared) via waitFor — that's the spec under test.
    void result.current.handleSave();

    await waitFor(() => {
      expect(result.current.dirtyBookIds.size).toBe(0);
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("handleSave keeps the dirty set when API returns error", async () => {
    const client = createMockApiClient({
      updatePersonalBooks: vi
        .fn()
        .mockResolvedValue({ error: { code: "BOOM", message: "failed" } }),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.dirtyBookIds.has("book-1")).toBe(true);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.status).toBe("error");
  });

  it("handleCancel clears the dirty set and restores books", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    const originalSnapshot = result.current.books.map((b) => ({
      ...b,
      isShared: b.isShared,
    }));

    act(() => {
      result.current.handleToggle("book-1");
      result.current.handleToggle("book-2");
    });
    expect(result.current.dirtyBookIds.size).toBe(2);
    expect(
      result.current.books.find((b) => b.bookId === "book-1")?.isShared,
    ).toBe(BoolFlag.TRUE);

    act(() => {
      result.current.handleCancel();
    });

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(
      result.current.books.find((b) => b.bookId === "book-1")?.isShared,
    ).toBe(originalSnapshot[0].isShared);
  });
});
