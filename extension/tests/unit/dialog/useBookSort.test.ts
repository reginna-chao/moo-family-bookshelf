import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBookSort } from "@/dialog/useBookSort";
import type { BookSortShelf } from "@/dialog/useBookSort";

/**
 * Production reads/writes sort via the promise-based
 * `browser.runtime.sendMessage(msg)` (webextension-polyfill). The mock returns a
 * Promise resolving to the response keyed by message type — there is no Chrome
 * callback argument. The mount read is async, so assertions on the loaded value
 * use `waitFor`.
 */
function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
    message: unknown,
  ) => {
    const msg = message as Record<string, unknown>;
    if (msg.type === "GET_BOOK_SORT") {
      return Promise.resolve(getResponse);
    }
    if (msg.type === "SET_BOOK_SORT") {
      return Promise.resolve(setResponse);
    }
    return Promise.resolve(undefined);
  }) as typeof chrome.runtime.sendMessage);
}

describe("useBookSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 'default'", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("family"));
    expect(result.current.sort).toBe("default");
  });

  it.each<{ shelf: BookSortShelf }>([
    { shelf: "family" },
    { shelf: "personal" },
  ])("reads sort from background for shelf '$shelf'", async ({ shelf }) => {
    mockSendMessage({ sort: "title-desc" });
    const { result } = renderHook(() => useBookSort(shelf));
    await waitFor(() => {
      expect(result.current.sort).toBe("title-desc");
    });
  });

  it.each<{ stored: string; expected: string }>([
    { stored: "title", expected: "title-asc" },
    { stored: "author", expected: "author-asc" },
  ])(
    "normalizes legacy read-back value '$stored' to '$expected'",
    async ({ stored, expected }) => {
      mockSendMessage({ sort: stored });
      const { result } = renderHook(() => useBookSort("family"));
      await waitFor(() => {
        expect(result.current.sort).toBe(expected);
      });
    },
  );

  it("normalizes an unrecognized read-back value to 'default'", async () => {
    mockSendMessage({ sort: "bogus" });
    const { result } = renderHook(() => useBookSort("family"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.sort).toBe("default");
  });

  it("sends correct shelf in GET_BOOK_SORT message", () => {
    mockSendMessage({ sort: "default" });
    renderHook(() => useBookSort("personal"));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "GET_BOOK_SORT",
      shelf: "personal",
    });
  });

  it("keeps 'default' when the background message rejects", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((() =>
      Promise.reject(
        new Error("background unavailable"),
      )) as typeof chrome.runtime.sendMessage);
    const { result } = renderHook(() => useBookSort("family"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.sort).toBe("default");
  });

  it("optimistically updates state on setSort", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("family"));

    act(() => {
      result.current.setSort("author-desc");
    });

    expect(result.current.sort).toBe("author-desc");
  });

  it("sends SET_BOOK_SORT with correct shelf and sort", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("personal"));

    act(() => {
      result.current.setSort("title-asc");
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_BOOK_SORT",
      shelf: "personal",
      sort: "title-asc",
    });
  });

  it("rolls back state when SET responds with ok: false", async () => {
    mockSendMessage({ sort: "default" }, { ok: false });
    const { result } = renderHook(() => useBookSort("family"));

    act(() => {
      result.current.setSort("title-asc");
    });
    expect(result.current.sort).toBe("title-asc");

    await waitFor(() => {
      expect(result.current.sort).toBe("default");
    });
  });

  it("does not send message when setting same sort", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("family"));

    vi.mocked(chrome.runtime.sendMessage).mockClear();

    act(() => {
      result.current.setSort("default");
    });

    const setCalls = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.filter(
        (call) =>
          (call[0] as unknown as Record<string, unknown>).type ===
          "SET_BOOK_SORT",
      );
    expect(setCalls).toHaveLength(0);
  });
});
