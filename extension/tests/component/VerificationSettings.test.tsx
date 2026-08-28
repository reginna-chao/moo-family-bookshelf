import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VerificationSettings } from "@/dialog/VerificationSettings";
import { rateLimitedMessage } from "@/dialog/verificationMessages";
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

  // Fake timers are installed mid-test (only after the real-clock settle), so
  // this suite owns the restore hook the rest of the file does not need.
  describe("stale saved->idle reset", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the saving indicator when the previous save's reset comes due", async () => {
      // Method buttons are disabled only while saveState === "saving", so a
      // second save is reachable inside the 2s 已儲存 window. If the first
      // save's pending saved->idle timer still fires, it drops the in-flight
      // save out of "saving" and the UI stops reporting the request.
      const api = createMockApiClient({
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "pin", prompted: 1 } }),
        setVerifyMethod: vi
          .fn()
          .mockResolvedValueOnce({ data: { ok: true } })
          // Second save never settles: only the stale timer can move the state.
          .mockImplementation(() => new Promise<never>(() => {})),
      });

      // Real clock: settle the initial load before touching timers. `act` (not
      // findBy/waitFor) is the ready signal — it guarantees pending effects are
      // flushed on exit, and waitFor cannot run once fake timers are installed.
      await act(async () => {
        render(<VerificationSettings userId="user-1" apiClient={api} />);
      });
      expect(screen.getByText("目前方式：PIN 碼")).toBeInTheDocument();

      vi.useFakeTimers();

      // First save succeeds and arms the 2000ms saved->idle reset.
      fireEvent.click(screen.getByText("不設定驗證"));
      await act(async () => {
        fireEvent.click(screen.getByText("確定不設定驗證"));
      });

      expect(screen.getByText("已儲存")).toBeInTheDocument();

      // Second save starts inside that window.
      await act(async () => {
        fireEvent.click(screen.getByText("隨機驗證碼"));
      });

      expect(screen.getByText("儲存中...")).toBeInTheDocument();

      // 2000ms is the saved->idle delay armed by the first save.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(screen.getByText("儲存中...")).toBeInTheDocument();
    });

    it("keeps a failed generation's error when the save's reset comes due", async () => {
      // 產生驗證碼 stays on screen through the 2s 已儲存 window (the save leaves
      // currentMethod === "code"), so a failed generation lands inside it.
      // handleGenerateOtp resets the status on entry — the same status the
      // save's pending timer owns — so unless that timer is superseded there
      // too, it fires afterwards and wipes an error the user has not read.
      const api = createMockApiClient({
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
        generateOtp: vi.fn().mockResolvedValue({
          error: { code: "SERVER_ERROR", message: "驗證碼服務暫時無法使用" },
        }),
      });

      // Real clock for the initial load, `act` as the ready signal — same
      // reasons as the test above.
      await act(async () => {
        render(<VerificationSettings userId="user-1" apiClient={api} />);
      });
      expect(screen.getByText("目前方式：隨機驗證碼")).toBeInTheDocument();

      vi.useFakeTimers();

      // Re-picking 隨機驗證碼 saves immediately (it is the one method with no
      // secret to collect) and arms the 2000ms saved->idle reset.
      await act(async () => {
        fireEvent.click(screen.getByText("隨機驗證碼"));
      });

      expect(screen.getByText("已儲存")).toBeInTheDocument();

      // Generation fails inside that window; the server's own message renders.
      await act(async () => {
        fireEvent.click(screen.getByText("產生驗證碼"));
      });

      expect(screen.getByText("驗證碼服務暫時無法使用")).toHaveClass(
        "moo-verify__status--error",
      );

      // 2000ms is the saved->idle delay armed by the save above.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(screen.getByText("驗證碼服務暫時無法使用")).toHaveClass(
        "moo-verify__status--error",
      );
    });
  });

  /**
   * `setVerifyMethod` resolves the `{ data, error }` envelope through
   * `readEnvelope`, which bare-casts `response.json()`
   * (extension/src/api/client.ts), and the endpoint is user-configurable (BYO
   * backend), so `error.message` is `unknown` at runtime. Before the
   * `safeErrorText` guard a non-string landed in `saveError` state and was
   * rendered as a JSX child — React 19 throws "Objects are not valid as a React
   * child" on an object/array, and the Dialog mounts no ErrorBoundary, so the
   * whole overlay went white on the very screen where the user would point the
   * endpoint back at a working host. The quieter half of the same bug: the site
   * assigned `result.error.message` verbatim, so an absent or empty message
   * left the error banner rendered but blank — a failure with nothing in it.
   *
   * Table modeled on the hostile-value `it.each` in BorrowRequestCard.test.tsx.
   */
  describe("hostile save-error envelopes", () => {
    /** 隨機驗證碼 is the only method that saves without collecting a secret. */
    async function selectCodeMethod(api: ApiClient) {
      render(<VerificationSettings userId="user-1" apiClient={api} />);
      await waitFor(() => {
        expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
      });
      // `act` is the barrier for the save: its state update lands in a promise
      // continuation that would otherwise settle outside any act scope, between
      // this helper resolving and the caller's next assertion.
      await act(async () => {
        fireEvent.click(screen.getByText("隨機驗證碼"));
      });
    }

    it.each([
      { name: "an object message", message: { zh: "壞掉了" } },
      { name: "an array message", message: ["壞掉了"] },
      { name: "a number message", message: 429 },
      { name: "a boolean message", message: true },
      { name: "a null message", message: null },
      { name: "a missing message", message: undefined },
      // Degrades too: a blank error tells the user nothing.
      { name: "an empty-string message", message: "" },
    ])(
      "shows the local save-failure copy for $name instead of crashing",
      async ({ message }) => {
        await selectCodeMethod(
          createMockApiClient({
            setVerifyMethod: vi.fn().mockResolvedValue({
              error: { code: "SERVER_ERROR", message },
            }),
          }),
        );

        // The literal lives in VerificationSettings.tsx (`handleSave`); this
        // assertion reads it back off the production render path. `getByText`
        // matches the node's whole text, so a hostile value that had reached
        // state would fail here rather than hide inside the same node.
        expect(screen.getByText("儲存失敗，請重試")).toHaveClass(
          "moo-verify__status--error",
        );
        // A thrown render tears the tree down; surviving, still-clickable UI is
        // what the regression is really about.
        expect(
          screen.getByRole("button", { name: "不設定驗證" }),
        ).toBeInTheDocument();
      },
    );
  });

  /**
   * `generateOtp` resolves the same bare-cast envelope, so `data.code` and
   * `data.expiresAt` are `unknown` too, and each fails differently:
   *
   * - a non-string `code` renders as a JSX child → the white Dialog above;
   * - a non-finite `expiresAt` breaks the 1s countdown — with `Infinity`,
   *   `remaining <= 0` is never true, so the interval never clears itself and
   *   keeps re-rendering for as long as the Dialog stays open.
   *
   * The component treats either as a failed generation: no OTP state is set, so
   * no timer starts, and the user gets local copy plus a retry button.
   */
  describe("OTP envelope guard", () => {
    /** The mock factory's happy-path code — must never surface below. */
    const VALID_CODE = "482916";
    const FUTURE_EXPIRY = Date.now() + 300_000;

    /** Renders with `code` active, so the generate button is on screen. */
    async function renderReadyToGenerate(overrides: Partial<ApiClient> = {}) {
      const api = createMockApiClient({
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
        ...overrides,
      });
      render(<VerificationSettings userId="user-1" apiClient={api} />);
      await waitFor(() => {
        expect(screen.getByText("產生驗證碼")).toBeInTheDocument();
      });
      return api;
    }

    /**
     * `act` is the barrier for the generate call: its state update lands in a
     * promise continuation, and the assertions run right after.
     */
    async function clickGenerate() {
      await act(async () => {
        fireEvent.click(screen.getByText("產生驗證碼"));
      });
    }

    it.each([
      { name: "an object code", data: { code: { v: VALID_CODE } } },
      { name: "an array code", data: { code: [VALID_CODE] } },
      // A JSON number renders harmlessly on its own; the guard is deliberately
      // type-strict, so an all-digit code arriving unquoted is refused with the
      // same copy as the shapes that do crash rather than half-trusted.
      { name: "a numeric code", data: { code: 482916 } },
      { name: "an empty code", data: { code: "" } },
      { name: "a missing code", data: { code: undefined } },
      { name: "a string expiry", data: { expiresAt: String(FUTURE_EXPIRY) } },
      { name: "a NaN expiry", data: { expiresAt: Number.NaN } },
      {
        name: "an infinite expiry",
        data: { expiresAt: Number.POSITIVE_INFINITY },
      },
      { name: "a null expiry", data: { expiresAt: null } },
      { name: "a missing expiry", data: { expiresAt: undefined } },
    ])("reports a failed generation for $name", async ({ data }) => {
      await renderReadyToGenerate({
        generateOtp: vi.fn().mockResolvedValue({
          // Each row overrides one half of an otherwise valid payload.
          data: { code: VALID_CODE, expiresAt: FUTURE_EXPIRY, ...data },
        }),
      });

      await clickGenerate();

      // Literal from VerificationSettings.tsx (`handleGenerateOtp`).
      expect(screen.getByText("驗證碼產生失敗，請重試")).toHaveClass(
        "moo-verify__status--error",
      );
      // Nothing unusable was promoted to OTP state...
      expect(screen.queryByText(VALID_CODE)).not.toBeInTheDocument();
      expect(screen.queryByText(/秒後過期/)).not.toBeInTheDocument();
      expect(screen.queryByText("已過期")).not.toBeInTheDocument();
      // ...and the user can try again.
      expect(
        screen.getByRole("button", { name: "產生驗證碼" }),
      ).toBeInTheDocument();
    });

    // Any code EXCEPT "RATE_LIMITED": that one is rewritten to local back-off
    // copy before `safeErrorText` is ever reached (next case), so it would pin
    // the opposite of the passthrough this case is about.
    it("shows the server's own message when a rejected generation carried one", async () => {
      await renderReadyToGenerate({
        generateOtp: vi.fn().mockResolvedValue({
          error: { code: "SERVER_ERROR", message: "驗證碼服務暫時無法使用" },
        }),
      });

      await clickGenerate();

      expect(screen.getByText("驗證碼服務暫時無法使用")).toBeInTheDocument();
      expect(
        screen.queryByText("驗證碼產生失敗，請重試"),
      ).not.toBeInTheDocument();
    });

    // Pins the order of the composition at this site: the 429 rewrite sits
    // ABOVE `safeErrorText`, so a rate-limited envelope keeps the localized
    // back-off copy no matter what its `message` holds.
    it("keeps the localized back-off copy when a rate-limited generation carries a hostile message", async () => {
      await renderReadyToGenerate({
        generateOtp: vi.fn().mockResolvedValue({
          error: {
            code: "RATE_LIMITED",
            message: { zh: "壞掉了" },
            retryAfter: 90,
          },
        }),
      });

      await clickGenerate();

      // Built by the production copy helper, whose literals are pinned in
      // tests/unit/dialog/verificationMessages.test.ts.
      expect(screen.getByText(rateLimitedMessage(90))).toBeInTheDocument();
      // The `??` chain must not fall through to the generic copy just because
      // the message was unusable — the 429 branch never reads `message`.
      expect(
        screen.queryByText("驗證碼產生失敗，請重試"),
      ).not.toBeInTheDocument();
      // A refused generation still promotes nothing to OTP state.
      expect(screen.queryByText(VALID_CODE)).not.toBeInTheDocument();
      expect(screen.queryByText(/秒後過期/)).not.toBeInTheDocument();
      expect(screen.queryByText("已過期")).not.toBeInTheDocument();
    });

    /**
     * The stuck-interval half of the guard. Asserted on the fake-timer queue
     * because that is the leak itself: the countdown is invisible once the OTP
     * state is refused, but an infinite deadline used to leave the interval
     * running.
     */
    describe("countdown timer hygiene", () => {
      afterEach(() => {
        // Tripwire, not decoration: a mid-body failure would leak a frozen
        // clock into the rest of the file, where RTL's waiters (which cannot
        // detect Vitest's fake timers) would hang to the full testTimeout
        // instead of failing where the bug is.
        vi.useRealTimers();
      });

      /**
       * Mounts under fake timers and clicks generate. `act` — not `findBy*` —
       * is the barrier at both steps: the button only exists after the load
       * effect's promise commits, and the countdown interval is published by
       * the effect that runs after the click's state update.
       */
      async function generateUnderFakeTimers(otpResult: unknown) {
        vi.useFakeTimers();
        const api = createMockApiClient({
          getVerifyMethod: vi
            .fn()
            .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
          generateOtp: vi.fn().mockResolvedValue(otpResult),
        });
        const view = render(
          <VerificationSettings userId="user-1" apiClient={api} />,
        );
        await act(async () => {});
        await act(async () => {
          fireEvent.click(screen.getByText("產生驗證碼"));
        });
        return view;
      }

      it("starts no countdown when the expiry never reaches zero", async () => {
        // Infinity, not NaN, is the true leak value: `if (!otpExpiresAt)
        // return` early-returns on NaN, so NaN never mounts the interval and a
        // NaN-based timer-count assertion pins nothing.
        const { unmount } = await generateUnderFakeTimers({
          data: { code: VALID_CODE, expiresAt: Number.POSITIVE_INFINITY },
        });

        expect(screen.getByText("驗證碼產生失敗，請重試")).toBeInTheDocument();
        expect(vi.getTimerCount()).toBe(0);

        unmount();
        expect(vi.getTimerCount()).toBe(0);
      });

      it("starts one countdown for a valid envelope and clears it on unmount", async () => {
        // Positive control: without it, a guard that rejected EVERYTHING would
        // pass the test above.
        const { unmount } = await generateUnderFakeTimers({
          data: { code: VALID_CODE, expiresAt: Date.now() + 300_000 },
        });

        expect(screen.getByText(VALID_CODE)).toBeInTheDocument();
        expect(vi.getTimerCount()).toBe(1);

        unmount();
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });
});
