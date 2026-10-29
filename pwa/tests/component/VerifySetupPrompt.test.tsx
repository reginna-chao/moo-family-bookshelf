import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { VerifySetupPrompt } from "@/components/VerifySetupPrompt";
import { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";

/**
 * VerifySetupPrompt: the PWA overlay that sets up (or skips) login verification.
 *
 * Prompt visibility (#343): whether the overlay opens is read from the owner-only
 * `getVerifyPrompted` (`GET /api/user/:id/verify/prompted`), never from the public
 * `getVerifyMethod`, which no longer carries `prompted` and since #396 only picks the first step
 * (VerifySetupPrompt.stepUp.test.tsx) — a PIN answer never opens the overlay on its own. Only an explicit `prompted: BoolFlag.FALSE`
 * opens it; an error envelope (an older self-hosted server answers the new route with 404
 * `NOT_FOUND`), a missing or wrongly typed field, and a rejected request all render nothing, so the
 * user is never blocked. The "loading" and "done" steps BOTH render null, so a "renders nothing"
 * assertion made before the request settles passes vacuously: `renderSettled` renders inside `act`
 * and waits one macrotask there, which drains the component's `.then().catch()` chain first.
 *
 * Hostile save-error envelopes: `setVerifyMethod` resolves the `{ data, error }` envelope through
 * `readEnvelope`, which bare-casts `response.json()` (shared/src/api/readEnvelope.ts), and the endpoint is
 * user-configurable (BYO backend), so `error.message` is `unknown` at runtime. This site used to read
 * it as `res.error.message || "…"`, and `||` lets every truthy non-string through — including
 * exactly the objects and arrays React 19 refuses as a JSX child. With no ErrorBoundary above it, the
 * throw took the whole page white while this overlay (`fixed inset-0`) was covering it. The fallback
 * literal lives in useVerifyMethodSave.ts (`saveMethod`) and is read back off the production render
 * path; `getByText` matches the node's whole text, so a hostile value that had reached state would
 * fail there rather than hide inside the same node.
 *
 * Rotated token hand-off (#378): a new pin / pattern / code revokes the account's shared auth token and
 * the save's response carries its replacement. The client already adopted it (pinned in
 * tests/unit/api/verifyApi.test.ts); the prompt hands it to `onTokenRotated` so App can persist it into
 * the session, and must do so BEFORE `onComplete` — whatever App does next belongs to the new token's
 * session. Asserted on `invocationCallOrder`, Vitest's global call sequence across mocks.
 *
 * One write per save (#399): the chosen method and the prompt-shown mark travel together in the PUT
 * body (`prompted: BoolFlag.TRUE`), and the save sends NO follow-up `markVerifyPrompted`
 * (`POST /verify/prompted`). That POST, on a stale KV read, wrote `{ method: "none", prompted: 1 }` and
 * silently replaced the method just chosen. Only the 「之後再說」 dismiss still calls it alone.
 */

// Mock the ApiClient
vi.mock("@/api/client", () => ({
  ApiClient: vi.fn(),
}));

const USER_ID = "a".repeat(64);

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getVerifyPrompted: vi.fn().mockResolvedValue({ data: { prompted: 0 } }),
    // `none` keeps the old choose flow; the PIN / pattern first step is in VerifySetupPrompt.stepUp.test.tsx.
    getVerifyMethod: vi.fn().mockResolvedValue({ data: { method: "none" } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { ok: true } }),
    markVerifyPrompted: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getEndpoint: vi.fn(() => DEFAULT_API_ENDPOINT),
    ...overrides,
  } as unknown as ApiClient;
}

describe("VerifySetupPrompt", () => {
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    mockOnComplete.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Render, then let `getVerifyPrompted` settle inside `act`. See the header → "Prompt visibility". */
  async function renderSettled(client: ApiClient) {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <VerifySetupPrompt
          userId={USER_ID}
          apiClient={client}
          onComplete={mockOnComplete}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!view) throw new Error("render did not run");
    return view;
  }

  it("should show method choices when prompted === 0", async () => {
    const client = createMockClient();

    await renderSettled(client);

    expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
    expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    expect(screen.getByText("不設定驗證")).toBeInTheDocument();
  });

  it("should decide visibility from the owner-only prompted endpoint, not the public verify GET", async () => {
    const client = createMockClient({
      getVerifyPrompted: vi.fn().mockResolvedValue({ data: { prompted: 1 } }),
      getVerifyMethod: vi.fn().mockResolvedValue({ data: { method: "pin" } }),
    });

    const { container } = await renderSettled(client);

    expect(client.getVerifyPrompted).toHaveBeenCalledTimes(1);
    expect(client.getVerifyPrompted).toHaveBeenCalledWith(USER_ID);
    // Read once, for the first step only; a PIN account already prompted still sees nothing.
    expect(client.getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe("");
  });

  // Each case would show the overlay if visibility were "not explicitly prompted" instead of "explicitly unprompted".
  it.each([
    {
      name: "already prompted (prompted: 1)",
      result: { data: { prompted: 1 } },
    },
    {
      name: "an error envelope from a server without the route",
      result: { error: { code: "NOT_FOUND", message: "Not found" } },
    },
    { name: "a data object missing the field", result: { data: {} } },
    { name: "a string prompted value", result: { data: { prompted: "0" } } },
    { name: "a null prompted value", result: { data: { prompted: null } } },
    { name: "an empty envelope", result: {} },
  ])("should render nothing for $name", async ({ result }) => {
    const client = createMockClient({
      getVerifyPrompted: vi.fn().mockResolvedValue(result),
    });

    const { container } = await renderSettled(client);

    expect(client.getVerifyPrompted).toHaveBeenCalledWith(USER_ID);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("設定登入驗證")).not.toBeInTheDocument();
    expect(mockOnComplete).not.toHaveBeenCalled();
  });

  it("should render nothing when the prompted request rejects", async () => {
    const client = createMockClient({
      getVerifyPrompted: vi.fn().mockRejectedValue(new Error("network")),
    });

    const { container } = await renderSettled(client);

    expect(client.getVerifyPrompted).toHaveBeenCalledWith(USER_ID);
    expect(container.innerHTML).toBe("");
    expect(mockOnComplete).not.toHaveBeenCalled();
  });

  // #342: the hint used to claim the verification is phone-only, but an Extension re-login needs it too.
  // #396: resetting now needs the current secret, so the old 「從擴充功能的「設定」改成新的」 advice is gone.
  it("should tell the user the verification also guards Extension re-login and what a change needs", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    const tip = await screen.findByText(/擴充功能需要重新登入時/);
    // Production literal in VerifySetupViews.tsx (`ChooseMethodView`); word-for-word the Extension's tip.
    expect(tip.textContent).toBe(
      "提示：用手機版（PWA）登入，或電腦上的擴充功能需要重新登入時，都要通過這個驗證。要改成別的方式，得先輸入目前的 PIN 碼或圖形。",
    );
    expect(
      screen.queryByText(/從擴充功能的「設定」改成新的/),
    ).not.toBeInTheDocument();
    // The old tip's self-hosted sentence moved into ForgotSecretHint; it must not linger anywhere.
    expect(
      screen.queryByText(/自架伺服器請找管理者協助/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/僅用於手機版/)).not.toBeInTheDocument();
  });

  it("should show confirm-skip warning when selecting no verification", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));

    await waitFor(() => {
      expect(screen.getByText("確定不設定驗證？")).toBeInTheDocument();
      expect(screen.getByText(/家庭成員若知道你的 Email/)).toBeInTheDocument();
    });
  });

  it("should call setVerifyMethod and onComplete when confirming skip", async () => {
    const mockSetVerify = vi.fn().mockResolvedValue({ data: { ok: true } });
    const mockMarkPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createMockClient({
      setVerifyMethod: mockSetVerify,
      markVerifyPrompted: mockMarkPrompted,
    });

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));

    await waitFor(() => {
      expect(screen.getByText("確定不設定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定不設定"));

    await waitFor(() => {
      expect(mockSetVerify).toHaveBeenCalledWith(USER_ID, {
        method: "none",
        prompted: BoolFlag.TRUE,
      });
      expect(mockOnComplete).toHaveBeenCalled();
    });
    expect(mockMarkPrompted).not.toHaveBeenCalled();
  });

  it("should call markVerifyPrompted and onComplete when dismissing", async () => {
    const mockMarkPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createMockClient({
      markVerifyPrompted: mockMarkPrompted,
    });

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("之後再說")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("之後再說"));

    await waitFor(() => {
      expect(mockMarkPrompted).toHaveBeenCalledWith(USER_ID);
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  it("should show PIN setup when selecting PIN", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("PIN 碼"));

    await waitFor(() => {
      expect(screen.getByText(/設定 PIN 碼/)).toBeInTheDocument();
    });
  });

  it("should show pattern setup when selecting pattern", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("圖形驗證"));

    await waitFor(() => {
      expect(screen.getByText(/設定圖形驗證/)).toBeInTheDocument();
    });
  });

  // #399: a follow-up POST /verify/prompted could overwrite the fresh `code` with `none`. See the header.
  it("should save the prompted mark in the PUT and send no POST /verify/prompted after choosing code (#399)", async () => {
    const mockSetVerify = vi.fn().mockResolvedValue({ data: { ok: true } });
    const mockMarkPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createMockClient({
      setVerifyMethod: mockSetVerify,
      markVerifyPrompted: mockMarkPrompted,
    });

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(mockSetVerify).toHaveBeenCalledWith(USER_ID, {
        method: "code",
        prompted: BoolFlag.TRUE,
      });
      expect(mockOnComplete).toHaveBeenCalled();
    });
    expect(mockSetVerify).toHaveBeenCalledTimes(1);
    expect(mockMarkPrompted).not.toHaveBeenCalled();
  });

  it("should go back to choose step when cancelling from PIN setup", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      fireEvent.click(screen.getByText("PIN 碼"));
    });

    await waitFor(() => {
      expect(screen.getByText(/設定 PIN 碼/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("取消"));

    await waitFor(() => {
      expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
    });
  });

  /** A non-string `error.message` from setVerifyMethod must neither crash the overlay nor reach the
   *  screen. See the header → "Hostile save-error envelopes". */
  describe("hostile save-error envelopes", () => {
    /** Walk to the one save that needs no secret: 不設定驗證 → 確定不設定. */
    async function confirmSkipWith(setVerifyMethod: ReturnType<typeof vi.fn>) {
      const client = createMockClient({ setVerifyMethod });
      render(
        <VerifySetupPrompt
          userId={USER_ID}
          apiClient={client}
          onComplete={mockOnComplete}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("不設定驗證")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("不設定驗證"));
      await waitFor(() => {
        expect(screen.getByText("確定不設定")).toBeInTheDocument();
      });
      // `act` is the barrier for the save: its state update lands in a promise continuation that would
      // otherwise settle outside any act scope, between this helper resolving and the next assertion.
      await act(async () => {
        fireEvent.click(screen.getByText("確定不設定"));
      });
    }

    it.each([
      { name: "an object message", message: { zh: "壞掉了" } },
      { name: "an array message", message: ["壞掉了"] },
      { name: "a number message", message: 500 },
      { name: "a boolean message", message: true },
      { name: "a null message", message: null },
      { name: "a missing message", message: undefined },
      // Degrades too: a blank error tells the user nothing.
      { name: "an empty-string message", message: "" },
    ])(
      "should show the local save-failure copy for $name instead of crashing",
      async ({ message }) => {
        await confirmSkipWith(
          vi.fn().mockResolvedValue({
            error: { code: "SERVER_ERROR", message },
          }),
        );

        // Production literal (useVerifyMethodSave.ts `saveMethod`), whole-text match so a hostile value
        // cannot hide in the same node. See the header → "Hostile save-error envelopes".
        expect(screen.getByText("儲存失敗，請重試。")).toHaveAttribute(
          "role",
          "alert",
        );
        // A thrown render tears the tree down; the still-mounted overlay is what the regression is
        // really about — and a failed save must not report completion.
        expect(screen.getByText("確定不設定驗證？")).toBeInTheDocument();
        expect(mockOnComplete).not.toHaveBeenCalled();
      },
    );

    it("should keep a usable server message unchanged", async () => {
      await confirmSkipWith(
        vi.fn().mockResolvedValue({
          error: { code: "INVALID_METHOD", message: "驗證方式無效" },
        }),
      );

      expect(screen.getByText("驗證方式無效")).toBeInTheDocument();
      expect(screen.queryByText("儲存失敗，請重試。")).not.toBeInTheDocument();
    });
  });

  /** The rotated token goes to `onTokenRotated` before anything else is sent. See the header →
   *  "Rotated token hand-off". */
  describe("rotated token hand-off", () => {
    const ROTATED_TOKEN = "0123456789abcdef".repeat(4);

    function rotatedResponse(method: string) {
      return {
        data: {
          method,
          prompted: 1,
          authToken: ROTATED_TOKEN,
          expiresAt: 1_700_000_000_000,
        },
      };
    }

    async function renderWith(
      client: ApiClient,
      onTokenRotated?: (authToken: string) => void,
    ) {
      await act(async () => {
        render(
          <VerifySetupPrompt
            userId={USER_ID}
            apiClient={client}
            onComplete={mockOnComplete}
            onTokenRotated={onTokenRotated}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    /** `act` is the barrier for the save and the `onComplete` chained after it. */
    async function clickAndSettle(element: HTMLElement) {
      await act(async () => {
        fireEvent.click(element);
      });
    }

    function expectCalledBefore(
      first: ReturnType<typeof vi.fn>,
      second: ReturnType<typeof vi.fn>,
    ) {
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first.mock.invocationCallOrder[0]).toBeLessThan(
        second.mock.invocationCallOrder[0],
      );
    }

    it("should hand the rotated token over before completing", async () => {
      const onTokenRotated = vi.fn();
      const client = createMockClient({
        setVerifyMethod: vi.fn().mockResolvedValue(rotatedResponse("code")),
      });
      await renderWith(client, onTokenRotated);

      await clickAndSettle(screen.getByText("隨機驗證碼"));

      expect(onTokenRotated).toHaveBeenCalledWith(ROTATED_TOKEN);
      expectCalledBefore(onTokenRotated, mockOnComplete);
    });

    it("should hand the rotated token over after a PIN is set up", async () => {
      const onTokenRotated = vi.fn();
      const setVerifyMethod = vi.fn().mockResolvedValue(rotatedResponse("pin"));
      const client = createMockClient({ setVerifyMethod });
      await renderWith(client, onTokenRotated);

      fireEvent.click(screen.getByText("PIN 碼"));
      fireEvent.change(screen.getByLabelText("PIN 輸入"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "確認" }));
      fireEvent.change(screen.getByLabelText("PIN 輸入"), {
        target: { value: "123456" },
      });
      await clickAndSettle(screen.getByRole("button", { name: "確認" }));

      expect(setVerifyMethod).toHaveBeenCalledWith(USER_ID, {
        method: "pin",
        prompted: BoolFlag.TRUE,
        secret: "123456",
      });
      expect(onTokenRotated).toHaveBeenCalledWith(ROTATED_TOKEN);
      expectCalledBefore(onTokenRotated, mockOnComplete);
    });

    it("should not call onTokenRotated when the save issues no token", async () => {
      const onTokenRotated = vi.fn();
      const client = createMockClient({
        setVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "none", prompted: 1 } }),
      });
      await renderWith(client, onTokenRotated);

      fireEvent.click(screen.getByText("不設定驗證"));
      await clickAndSettle(screen.getByText("確定不設定"));

      expect(mockOnComplete).toHaveBeenCalledTimes(1);
      expect(onTokenRotated).not.toHaveBeenCalled();
    });

    it("should not call onTokenRotated when the save fails", async () => {
      const onTokenRotated = vi.fn();
      const markVerifyPrompted = vi
        .fn()
        .mockResolvedValue({ data: { ok: true } });
      const client = createMockClient({
        setVerifyMethod: vi.fn().mockResolvedValue({
          error: { code: "SERVER_ERROR", message: "伺服器忙碌" },
        }),
        markVerifyPrompted,
      });
      await renderWith(client, onTokenRotated);

      await clickAndSettle(screen.getByText("隨機驗證碼"));

      expect(screen.getByText("伺服器忙碌")).toBeInTheDocument();
      expect(onTokenRotated).not.toHaveBeenCalled();
      expect(markVerifyPrompted).not.toHaveBeenCalled();
      expect(mockOnComplete).not.toHaveBeenCalled();
    });

    it("should complete normally when no onTokenRotated is passed", async () => {
      const client = createMockClient({
        setVerifyMethod: vi.fn().mockResolvedValue(rotatedResponse("code")),
      });
      await renderWith(client);

      await clickAndSettle(screen.getByText("隨機驗證碼"));

      expect(mockOnComplete).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  /** The forgot-secret hint shows only on the steps before a new secret is entered; copy pinned as
   *  literals, as in ForgotSecretHint.test.tsx. */
  describe("forgot-secret hint", () => {
    const LINK_LABEL = "填寫救援申請";
    const SELF_HOSTED_LINE = "忘記的話，請找伺服器管理者協助。";
    it.each([
      { step: "keep-or-change", method: "pin", change: false },
      { step: "current-secret", method: "pin", change: true },
      { step: "choose", method: "none", change: false },
    ])(
      "links to the recovery form on the $step step",
      async ({ method, change }) => {
        await renderSettled(
          createMockClient({
            getVerifyMethod: vi.fn().mockResolvedValue({ data: { method } }),
          }),
        );
        if (change) {
          fireEvent.click(screen.getByRole("button", { name: "改" }));
          // Landed on the current-secret entry, not still on keep-or-change.
          expect(screen.getByLabelText("PIN 輸入")).toBeInTheDocument();
        }

        const link = screen.getByRole("link", { name: LINK_LABEL });
        expect(link).toHaveAttribute(
          "href",
          `https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?platform=googleform&topic=recovery&v=${__APP_VERSION__}`,
        );
        expect(link).toHaveAttribute("target", "_blank");
        expect(link.closest("p")?.textContent).toBe(
          `沒辦法完成驗證？${LINK_LABEL}`,
        );
        expect(screen.queryByText(SELF_HOSTED_LINE)).not.toBeInTheDocument();
      },
    );

    it.each([
      { choice: "PIN 碼", step: "setup-pin" },
      { choice: "圖形驗證", step: "setup-pattern" },
      { choice: "不設定驗證", step: "confirm-skip" },
    ])("hides the hint on the $step step", async ({ choice }) => {
      await renderSettled(createMockClient());
      // Positive companion: the hint is on the choose step this one is reached from.
      expect(
        screen.getByRole("link", { name: LINK_LABEL }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByText(choice));

      expect(
        screen.queryByRole("link", { name: LINK_LABEL }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/沒辦法完成驗證/)).not.toBeInTheDocument();
      expect(screen.queryByText(SELF_HOSTED_LINE)).not.toBeInTheDocument();
    });

    it("points a self-hosted user at the admin, with no link", async () => {
      await renderSettled(
        createMockClient({
          getEndpoint: vi.fn(() => "https://nas.example.com/moo"),
        }),
      );

      expect(screen.getByText(SELF_HOSTED_LINE)).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: LINK_LABEL }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(new RegExp(LINK_LABEL)),
      ).not.toBeInTheDocument();
    });
  });
});
