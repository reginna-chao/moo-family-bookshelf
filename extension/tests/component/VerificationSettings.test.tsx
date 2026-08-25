import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VerificationSettings } from "@/dialog/VerificationSettings";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "none", prompted: 0 } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { ok: true } }),
    generateOtp: vi.fn().mockResolvedValue({
      data: { code: "482916", expiresAt: Date.now() + 300000 },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

describe("VerificationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state then current method", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    expect(screen.getByText("載入中...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("目前方式：不設定驗證")).toBeInTheDocument();
    });
  });

  it("displays current method from server", async () => {
    const api = createMockApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "pin", prompted: 1 } }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("目前方式：PIN 碼")).toBeInTheDocument();
    });
  });

  // Also the Map-completeness guard: METHOD_LABELS is iterated to build these
  // buttons, so a label dropped from (or added to) the Map fails here — the
  // old `Record<VerifyMethod, string>` gave that for free at compile time.
  it("renders all 4 method buttons", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    });
    expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    expect(screen.getByText("不設定驗證")).toBeInTheDocument();
  });

  it("shows PIN input when PIN method is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("PIN 碼"));
    expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
  });

  it("shows pattern lock when pattern method is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("圖形驗證"));
    expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
  });

  it("saves immediately when code method is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(api.setVerifyMethod).toHaveBeenCalledWith("user-1", {
        method: "code",
      });
    });
  });

  it("shows warning when none is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));
    expect(
      screen.getByText("家庭成員若知道你的 Email，可能在手機版登入你的帳號"),
    ).toBeInTheDocument();
  });

  it("saves none method after confirming warning", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));
    fireEvent.click(screen.getByText("確定不設定驗證"));

    await waitFor(() => {
      expect(api.setVerifyMethod).toHaveBeenCalledWith("user-1", {
        method: "none",
      });
    });
  });

  it("shows generate OTP button when current method is code", async () => {
    const api = createMockApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("產生驗證碼")).toBeInTheDocument();
    });
  });

  it("generates and displays OTP code", async () => {
    const api = createMockApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("產生驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("產生驗證碼"));

    await waitFor(() => {
      expect(screen.getByText("482916")).toBeInTheDocument();
    });
  });

  it("shows saved confirmation after successful save", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("shows error on save failure", async () => {
    const api = createMockApiClient({
      setVerifyMethod: vi.fn().mockResolvedValue({
        error: { code: "INVALID", message: "驗證方式無效" },
      }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(screen.getByText("驗證方式無效")).toBeInTheDocument();
    });
  });

  /**
   * `method` is bare-cast out of the API response by `getVerifyMethod()`
   * (extension/src/api/client.ts:535) and stored unvalidated in this
   * component's state, and the API endpoint is user-configurable (BYO
   * backend), so an out-of-union value reaches this render. The label lookup
   * is a Map rather than an object literal precisely so a prototype-chain key
   * resolves to nothing, and a miss must degrade to the fallback label — a
   * throw here takes down the whole Dialog, which has no ErrorBoundary, on the
   * very tab where the user would switch the endpoint back.
   */
  describe("current-method label", () => {
    /**
     * Typed as `Record<VerifyMethod, string>` on purpose: it restores the
     * compile-time exhaustiveness production gave up when METHOD_LABELS became
     * a Map. A new union member fails typecheck here until this table — and
     * the Map — cover it.
     */
    const KNOWN_METHOD_LABELS: Record<VerifyMethod, string> = {
      pin: "PIN 碼",
      pattern: "圖形驗證",
      code: "隨機驗證碼",
      none: "不設定驗證",
    };

    function renderWithMethod(method: VerifyMethod) {
      const api = createMockApiClient({
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method, prompted: 0 } }),
      });
      return render(<VerificationSettings userId="user-1" apiClient={api} />);
    }

    it.each(
      Object.entries(KNOWN_METHOD_LABELS).map(([method, label]) => ({
        method: method as VerifyMethod,
        label,
      })),
    )(
      "labels the known method $method as $label",
      async ({ method, label }) => {
        renderWithMethod(method);

        await waitFor(() => {
          expect(screen.getByText(`目前方式：${label}`)).toBeInTheDocument();
        });
      },
    );

    it.each([
      { name: '"__proto__"', method: "__proto__" },
      { name: '"toString"', method: "toString" },
      { name: '"constructor"', method: "constructor" },
      { name: '"valueOf"', method: "valueOf" },
      { name: '"hasOwnProperty"', method: "hasOwnProperty" },
      { name: "an unknown method name", method: "fingerprint" },
      // A backend that simply omits `method` is the likeliest out-of-union
      // case, and pins the `?? "none"` branch of the lookup.
      { name: "a null method", method: null },
      { name: "a missing method (undefined)", method: undefined },
    ])(
      "falls back to the no-verification label for $name instead of crashing",
      async ({ method }) => {
        // The crash was on the re-render AFTER getVerifyMethod resolved (the
        // first paint is the loading state), so the settled DOM below is the
        // assertion that carries the regression: a throw tears the tree down
        // and neither the label nor the buttons are ever found.
        renderWithMethod(method as unknown as VerifyMethod);

        await waitFor(() => {
          expect(screen.getByText("目前方式：不設定驗證")).toBeInTheDocument();
        });

        // Dialog stays usable — every method button still renders.
        for (const label of Object.values(KNOWN_METHOD_LABELS)) {
          expect(
            screen.getByRole("button", { name: label }),
          ).toBeInTheDocument();
        }
      },
    );
  });
});
