import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBookSort } from "@/dialog/useBookSort";
import type { BookSortShelf } from "@/dialog/useBookSort";

type SendMessageCallback = (response: Record<string, unknown>) => void;

function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    ((message: unknown, callback: SendMessageCallback) => {
      const msg = message as Record<string, unknown>;
      if (msg.type === "GET_BOOK_SORT") {
        callback(getResponse);
      } else if (msg.type === "SET_BOOK_SORT") {
        callback(setResponse);
      }
    }) as typeof chrome.runtime.sendMessage,
  );
}

describe("useBookSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(chrome.runtime, "lastError", { value: null, writable: true, configurable: true });
  });

  it("defaults to 'default'", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("family"));
    expect(result.current.sort).toBe("default");
  });

  it.each<{ shelf: BookSortShelf }>([
    { shelf: "family" },
    { shelf: "personal" },
  ])("reads sort from background for shelf '$shelf'", ({ shelf }) => {
    mockSendMessage({ sort: "title" });
    const { result } = renderHook(() => useBookSort(shelf));
    expect(result.current.sort).toBe("title");
  });

  it("sends correct shelf in GET_BOOK_SORT message", () => {
    mockSendMessage({ sort: "default" });
    renderHook(() => useBookSort("personal"));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "GET_BOOK_SORT", shelf: "personal" },
      expect.any(Function),
    );
  });

  it("keeps 'default' when chrome.runtime.lastError is set", () => {
    Object.defineProperty(chrome.runtime, "lastError", {
      value: { message: "error" },
      writable: true,
      configurable: true,
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((_message: unknown, callback: SendMessageCallback) => {
        callback({ sort: "title" });
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useBookSort("family"));
    expect(result.current.sort).toBe("default");
  });

  it("optimistically updates state on setSort", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("family"));

    act(() => {
      result.current.setSort("author");
    });

    expect(result.current.sort).toBe("author");
  });

  it("sends SET_BOOK_SORT with correct shelf and sort", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("personal"));

    act(() => {
      result.current.setSort("title");
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "SET_BOOK_SORT", shelf: "personal", sort: "title" },
      expect.any(Function),
    );
  });

  it("rolls back state when SET responds with ok: false", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((message: unknown, callback: SendMessageCallback) => {
        const msg = message as Record<string, unknown>;
        if (msg.type === "GET_BOOK_SORT") {
          callback({ sort: "default" });
        } else if (msg.type === "SET_BOOK_SORT") {
          Promise.resolve().then(() => callback({ ok: false }));
        }
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useBookSort("family"));

    act(() => {
      result.current.setSort("title");
    });
    expect(result.current.sort).toBe("title");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sort).toBe("default");
  });

  it("does not send message when setting same sort", () => {
    mockSendMessage({ sort: "default" });
    const { result } = renderHook(() => useBookSort("family"));

    vi.mocked(chrome.runtime.sendMessage).mockClear();

    act(() => {
      result.current.setSort("default");
    });

    const setCalls = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(
      (call) => (call[0] as unknown as Record<string, unknown>).type === "SET_BOOK_SORT",
    );
    expect(setCalls).toHaveLength(0);
  });
});
