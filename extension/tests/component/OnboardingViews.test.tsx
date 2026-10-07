import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SYNC_CODE_HOST_SETTLE_DELAY_MS } from "moo-family-bookshelf-shared/api/syncCodeHost";
import {
  WelcomeView,
  CreatedView,
  ErrorView,
  IdleView,
  type IdleViewProps,
} from "@/dialog/OnboardingViews";
import {
  HALF_TYPED_PREFIXES,
  LAN_CODE,
  LAN_ENDPOINT,
  SPOOFED_CODE,
  TRUSTED_CODE,
  TRUSTED_ENDPOINT,
} from "../helpers/syncCodeHostFixtures";

/**
 * Only `decodeSyncCode` is stubbed — CreatedView's rendering of a generated code
 * is what these tests drive. The rest of the module stays real, notably
 * `parseSyncCodeApiHost`, which IdleView's SyncCodeHostNote calls on every
 * keystroke; stubbing the whole module would make the note untestable here.
 *
 * Styling contract: after the Shadow DOM + scoped-CSS conversion, styling moved from inline styles to
 * classes in styles.css, and jsdom does not apply stylesheet rules, so the class is the observable
 * contract — the monospace sync code is `.moo-onboarding-view__code-text`; the error heading's red is
 * the `--error` modifier on the base heading class; the filled-blue primary vs outlined secondary
 * (transparent bg + blue border) buttons are `moo-onboarding-view__primary` / `__secondary`, asserted
 * present-and-absent so the two variants stay distinct. The restored
 * `.moo-onboarding-view { padding: 24px }` rule and the mobile centering media query both target the
 * `moo-onboarding-view` wrapper, so the class is pinned onto the rendered root to keep those selectors
 * matching real DOM (jsdom cannot verify the padding itself).
 *
 * Custom-server note timing — WHEN the warning may appear, as opposed to what it says. The warning
 * used to be live, so it flashed through nearly every keystroke of a half-typed `@host`, and a warning
 * that cries wolf during normal typing is one the user is trained to dismiss. That is fatal here: it is
 * the last human-facing defence against a userinfo-spoofed endpoint, which would ship the auth token
 * and the whole book list to the attacker. So it is DELAYED until the value settles, and never
 * suppressed. Kept symmetric with the PWA's copy in pwa/tests/component/LandingPage.test.tsx — the
 * policy lives in `shared/` exactly so the two cannot drift. The hazard the mechanism must not create:
 * if the delay KEPT the last rendered note, appending `@evil.com` to a host the user already saw named
 * would leave a reassuring "will connect to api.moofamily.app" standing over a spoofed address —
 * lending the spoof exactly the legitimacy the warning exists to deny.
 */
vi.mock("@/crypto/syncCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/crypto/syncCode")>()),
  decodeSyncCode: vi.fn().mockReturnValue({
    familyId: "abc123",
  }),
}));

import { decodeSyncCode } from "@/crypto/syncCode";
const mockDecodeSyncCode = vi.mocked(decodeSyncCode);

describe("WelcomeView", () => {
  it("renders heading and description", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(screen.getByText("歡迎使用家庭書櫃")).toBeInTheDocument();
    expect(
      screen.getByText("一鍵開始，自動同步你的讀墨帳號與書單。"),
    ).toBeInTheDocument();
  });

  it("renders start button", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(
      screen.getByRole("button", { name: "開始使用" }),
    ).toBeInTheDocument();
  });

  it("calls onStart when button is clicked", () => {
    const onStart = vi.fn();
    render(<WelcomeView onStart={onStart} />);

    fireEvent.click(screen.getByText("開始使用"));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("renders privacy notice", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(
      screen.getByText(/我們僅讀取你的帳號信箱用於生成匿名識別碼/),
    ).toBeInTheDocument();
  });

  it("renders '繼續使用' button when hasUsedBefore is true", () => {
    render(<WelcomeView onStart={() => {}} hasUsedBefore={true} />);

    expect(
      screen.getByRole("button", { name: "繼續使用" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "開始使用" }),
    ).not.toBeInTheDocument();
  });

  it("renders recovery subtitle when hasUsedBefore is true", () => {
    render(<WelcomeView onStart={() => {}} hasUsedBefore={true} />);

    expect(
      screen.getByText("偵測到你曾使用過家庭書櫃，請重新設定以繼續。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("一鍵開始，自動同步你的讀墨帳號與書單。"),
    ).not.toBeInTheDocument();
  });

  it("renders default text when hasUsedBefore is false", () => {
    render(<WelcomeView onStart={() => {}} hasUsedBefore={false} />);

    expect(
      screen.getByRole("button", { name: "開始使用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("一鍵開始，自動同步你的讀墨帳號與書單。"),
    ).toBeInTheDocument();
  });

  it("renders default text when hasUsedBefore is undefined", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(
      screen.getByRole("button", { name: "開始使用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("一鍵開始，自動同步你的讀墨帳號與書單。"),
    ).toBeInTheDocument();
  });

  it("calls onStart when '繼續使用' button is clicked", () => {
    const onStart = vi.fn();
    render(<WelcomeView onStart={onStart} hasUsedBefore={true} />);

    fireEvent.click(screen.getByText("繼續使用"));
    expect(onStart).toHaveBeenCalledOnce();
  });
});

describe("CreatedView", () => {
  const defaultProps = {
    generatedSyncCode: "moo-abc123",
    copied: false,
    onCopy: vi.fn(),
    onContinue: vi.fn(),
  };

  it("renders sync code", () => {
    render(<CreatedView {...defaultProps} />);

    expect(screen.getByText(/moo-abc123/)).toBeInTheDocument();
  });

  it("renders heading", () => {
    render(<CreatedView {...defaultProps} />);

    expect(screen.getByText("家庭公開書櫃已建立")).toBeInTheDocument();
  });

  it("renders description about sharing sync code", () => {
    render(<CreatedView {...defaultProps} />);

    expect(screen.getByText(/將以下同步碼分享給家人/)).toBeInTheDocument();
  });

  it("shows copy button with default text", () => {
    render(<CreatedView {...defaultProps} copied={false} />);

    expect(
      screen.getByRole("button", { name: "複製同步碼" }),
    ).toBeInTheDocument();
  });

  it("shows '已複製' when copied is true", () => {
    render(<CreatedView {...defaultProps} copied={true} />);

    expect(screen.getByRole("button", { name: "已複製" })).toBeInTheDocument();
  });

  it("calls onCopy when copy button clicked", () => {
    const onCopy = vi.fn();
    render(<CreatedView {...defaultProps} onCopy={onCopy} />);

    fireEvent.click(screen.getByText("複製同步碼"));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("renders continue button", () => {
    render(<CreatedView {...defaultProps} />);

    expect(screen.getByRole("button", { name: "繼續" })).toBeInTheDocument();
  });

  it("calls onContinue when continue button clicked", () => {
    const onContinue = vi.fn();
    render(<CreatedView {...defaultProps} onContinue={onContinue} />);

    fireEvent.click(screen.getByText("繼續"));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("sync code is displayed in monospace font", () => {
    // The monospace font is the `.moo-onboarding-view__code-text` class (see the file header,
    // "Styling contract").
    render(<CreatedView {...defaultProps} />);

    const codeEl = screen.getByText(/moo-abc123/);
    expect(codeEl).toHaveClass("moo-onboarding-view__code-text");
  });

  it("renders sync code with @host suffix when present", () => {
    mockDecodeSyncCode.mockReturnValue({
      familyId: "abc123",
      apiHost: "http://localhost:8787",
    });

    render(
      <CreatedView
        {...defaultProps}
        generatedSyncCode="moo-abc123@http://localhost:8787"
      />,
    );

    expect(
      screen.getByText("moo-abc123@http://localhost:8787"),
    ).toBeInTheDocument();

    // Restore default mock for subsequent tests
    mockDecodeSyncCode.mockReturnValue({
      familyId: "abc123",
    });
  });

  it("should show raw sync code without garbled prefix when decode fails", () => {
    mockDecodeSyncCode.mockImplementation(() => {
      throw new Error("Invalid sync code");
    });

    render(<CreatedView {...defaultProps} generatedSyncCode="raw-bad-code" />);

    expect(screen.getByText("raw-bad-code")).toBeInTheDocument();

    // Restore default mock
    mockDecodeSyncCode.mockReturnValue({
      familyId: "abc123",
    });
  });
});

describe("ErrorView", () => {
  it("renders error heading with red color", () => {
    // The red color is the `--error` heading modifier: assert the base heading class plus that modifier
    // (see the file header, "Styling contract").
    render(
      <ErrorView
        errorMessage="測試錯誤"
        actions={[{ label: "重試", onClick: () => {} }]}
      />,
    );

    const heading = screen.getByText("發生錯誤");
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveClass("moo-onboarding-view__heading");
    expect(heading).toHaveClass("moo-onboarding-view__heading--error");
  });

  it("renders error message text", () => {
    render(
      <ErrorView
        errorMessage="伺服器無回應"
        actions={[{ label: "重試", onClick: () => {} }]}
      />,
    );

    expect(screen.getByText("伺服器無回應")).toBeInTheDocument();
  });

  it("renders single action button", () => {
    render(
      <ErrorView
        errorMessage="錯誤"
        actions={[{ label: "重試", onClick: () => {} }]}
      />,
    );

    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("calls onClick when action button is clicked", () => {
    const onClick = vi.fn();
    render(
      <ErrorView errorMessage="錯誤" actions={[{ label: "重試", onClick }]} />,
    );

    fireEvent.click(screen.getByText("重試"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders multiple actions", () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(
      <ErrorView
        errorMessage="錯誤"
        actions={[
          { label: "改用同步碼", variant: "primary", onClick: onPrimary },
          { label: "重試", variant: "secondary", onClick: onSecondary },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "改用同步碼" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("primary variant renders filled blue button", () => {
    // Filled blue is the primary class, and the secondary class is absent (see the file header,
    // "Styling contract").
    render(
      <ErrorView
        errorMessage="錯誤"
        actions={[{ label: "確認", variant: "primary", onClick: () => {} }]}
      />,
    );

    const btn = screen.getByRole("button", { name: "確認" });
    expect(btn).toHaveClass("moo-onboarding-view__primary");
    expect(btn).not.toHaveClass("moo-onboarding-view__secondary");
  });

  it("secondary variant renders outlined button", () => {
    // Outlined styling is `moo-onboarding-view__secondary`: secondary present and primary absent, so the
    // two variants stay distinct.
    render(
      <ErrorView
        errorMessage="錯誤"
        actions={[{ label: "取消", variant: "secondary", onClick: () => {} }]}
      />,
    );

    const btn = screen.getByRole("button", { name: "取消" });
    expect(btn).toHaveClass("moo-onboarding-view__secondary");
    expect(btn).not.toHaveClass("moo-onboarding-view__primary");
  });

  it("triggers correct onClick for each action independently", () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <ErrorView
        errorMessage="錯誤"
        actions={[
          { label: "第一個", variant: "primary", onClick: onFirst },
          { label: "第二個", variant: "secondary", onClick: onSecond },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("第二個"));
    expect(onSecond).toHaveBeenCalledOnce();
    expect(onFirst).not.toHaveBeenCalled();
  });
});

describe("IdleView", () => {
  const defaultProps: IdleViewProps = {
    state: "idle",
    syncCodeInput: "",
    isProcessing: false,
    onSetSyncCodeInput: vi.fn(),
    onCreate: vi.fn(),
    onJoin: vi.fn(),
  };

  it("renders heading and description", () => {
    render(<IdleView {...defaultProps} />);

    expect(screen.getByText("歡迎使用家庭書櫃")).toBeInTheDocument();
    expect(screen.getByText(/建立或加入家庭公開書櫃/)).toBeInTheDocument();
  });

  it("renders create button", () => {
    render(<IdleView {...defaultProps} />);

    expect(
      screen.getByRole("button", { name: "建立家庭公開書櫃" }),
    ).toBeInTheDocument();
  });

  it("calls onCreate when create button clicked", () => {
    const onCreate = vi.fn();
    render(<IdleView {...defaultProps} onCreate={onCreate} />);

    fireEvent.click(screen.getByText("建立家庭公開書櫃"));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("renders sync code input and join button", () => {
    render(<IdleView {...defaultProps} />);

    expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "加入家庭公開書櫃" }),
    ).toBeInTheDocument();
  });

  it("join button is disabled when sync code input is empty", () => {
    render(<IdleView {...defaultProps} syncCodeInput="" />);

    expect(
      screen.getByRole("button", { name: "加入家庭公開書櫃" }),
    ).toBeDisabled();
  });

  it("join button is enabled when sync code input has text", () => {
    render(<IdleView {...defaultProps} syncCodeInput="moo-test-code" />);

    expect(
      screen.getByRole("button", { name: "加入家庭公開書櫃" }),
    ).toBeEnabled();
  });

  it("calls onJoin when join button clicked", () => {
    const onJoin = vi.fn();
    render(
      <IdleView
        {...defaultProps}
        syncCodeInput="moo-test-code"
        onJoin={onJoin}
      />,
    );

    fireEvent.click(screen.getByText("加入家庭公開書櫃"));
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("calls onSetSyncCodeInput on input change", () => {
    const onSetSyncCodeInput = vi.fn();
    render(
      <IdleView {...defaultProps} onSetSyncCodeInput={onSetSyncCodeInput} />,
    );

    fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
      target: { value: "moo-new-code" },
    });
    expect(onSetSyncCodeInput).toHaveBeenCalledWith("moo-new-code");
  });

  it("disables create button when isProcessing is true", () => {
    render(<IdleView {...defaultProps} isProcessing={true} />);

    expect(
      screen.getByRole("button", { name: "建立家庭公開書櫃" }),
    ).toBeDisabled();
  });

  it("disables join button when isProcessing is true", () => {
    render(
      <IdleView
        {...defaultProps}
        syncCodeInput="moo-test"
        isProcessing={true}
      />,
    );

    expect(
      screen.getByRole("button", { name: "加入家庭公開書櫃" }),
    ).toBeDisabled();
  });

  it("disables input when isProcessing is true", () => {
    render(<IdleView {...defaultProps} isProcessing={true} />);

    expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeDisabled();
  });

  it("shows '建立中...' when state is creating", () => {
    render(<IdleView {...defaultProps} state="creating" isProcessing={true} />);

    expect(screen.getByText("建立中...")).toBeInTheDocument();
  });

  it("shows '加入中...' when state is joining", () => {
    render(
      <IdleView
        {...defaultProps}
        state="joining"
        syncCodeInput="moo-test"
        isProcessing={true}
      />,
    );

    expect(screen.getByText("加入中...")).toBeInTheDocument();
  });

  it("renders '或' separator between create and join", () => {
    render(<IdleView {...defaultProps} />);

    expect(screen.getByText("或")).toBeInTheDocument();
  });

  it("sync code input is text type", () => {
    render(<IdleView {...defaultProps} />);

    const input = screen.getByPlaceholderText("輸入家庭同步碼");
    expect(input).toHaveAttribute("type", "text");
  });

  /** Joining via an `@host` sync code silently repoints the client at someone else's server, so the
   *  host is surfaced BEFORE the user presses join. */
  describe("custom-server note", () => {
    it("names the host while a sync code carrying @host is typed", () => {
      render(
        <IdleView
          {...defaultProps}
          syncCodeInput="moo-ab12-cd34@https://custom.example.com"
        />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent("此同步碼將連線至自訂伺服器：");
      // The canonical endpoint, scheme included — it must match what the join
      // path would actually adopt, not the raw text the sharer typed.
      expect(note).toHaveTextContent("https://custom.example.com");
    });

    it("shows the canonical endpoint, not the raw @host segment", () => {
      render(
        <IdleView
          {...defaultProps}
          syncCodeInput="moo-ab12-cd34@https://CUSTOM.Example.COM:443/api"
        />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      // Lower-cased, default port dropped, path kept.
      expect(note).toHaveTextContent("https://custom.example.com/api");
      expect(note.textContent).not.toContain("CUSTOM.Example.COM");
      expect(note.textContent).not.toContain(":443");
    });

    it.each([
      ["the input is empty", ""],
      ["the code carries no @host", "moo-ab12-cd34"],
      ["the code is still being typed", "moo-ab12"],
      ["the @ has no host after it yet", "moo-ab12-cd34@"],
    ])("shows no note when %s", (_label, syncCodeInput) => {
      render(<IdleView {...defaultProps} syncCodeInput={syncCodeInput} />);

      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("sync-code-host-note-invalid"),
      ).not.toBeInTheDocument();
    });

    /** A `@host` the join path would refuse must NOT get the reassuring "will connect to …" line — that
     *  would lend a spoofed address legitimacy where the user decides to join. */
    it("warns instead of naming the host when the @host would be refused", () => {
      render(
        <IdleView
          {...defaultProps}
          syncCodeInput="moo-ab12-cd34@https://real.example@evil.com"
        />,
      );

      const warning = screen.getByTestId("sync-code-host-note-invalid");
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning).toHaveTextContent(
        "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
      );
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(warning.textContent).not.toContain("real.example");
    });

    it.each([
      // Bare hosts were ALWAYS refused at adoption (`new URL()` needs a scheme);
      // the note now says so instead of presenting one as a trusted server.
      ["a bare host with no scheme", "moo-ab12-cd34@my-worker.example.com"],
      ["plain HTTP on a public host", "moo-ab12-cd34@http://evil.example.com"],
      ["a non-HTTP scheme", "moo-ab12-cd34@ftp://files.example.com"],
    ])("warns about %s", (_label, syncCodeInput) => {
      render(<IdleView {...defaultProps} syncCodeInput={syncCodeInput} />);

      expect(
        screen.getByTestId("sync-code-host-note-invalid"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
    });

    it("still lets the user press join — the note is advisory, not a block", () => {
      const onJoin = vi.fn();
      render(
        <IdleView
          {...defaultProps}
          onJoin={onJoin}
          syncCodeInput="moo-ab12-cd34@my-worker.example.com"
        />,
      );

      const joinBtn = screen.getByRole("button", {
        name: "加入家庭公開書櫃",
      });
      expect(joinBtn).toBeEnabled();
      fireEvent.click(joinBtn);
      expect(onJoin).toHaveBeenCalledOnce();
    });
  });

  /** The warning is DELAYED until the value settles, never suppressed; symmetric with the PWA's
   *  LandingPage.test.tsx. See the file header, "Custom-server note timing". */
  describe("custom-server note timing", () => {
    /** IdleView is controlled by Onboarding.tsx (`flow.syncCodeInput` / `flow.setSyncCodeInput`); this
     *  wrapper drives the real input → onChange → prop round trip, onPaste / onBlur included. */
    function ControlledIdleView({
      initialSyncCode = "",
      onJoin = () => {},
    }: {
      initialSyncCode?: string;
      onJoin?: () => void;
    }) {
      const [syncCodeInput, setSyncCodeInput] = useState(initialSyncCode);
      return (
        <IdleView
          state="idle"
          syncCodeInput={syncCodeInput}
          isProcessing={false}
          onSetSyncCodeInput={setSyncCodeInput}
          onCreate={() => {}}
          onJoin={onJoin}
        />
      );
    }

    function syncCodeField(): HTMLElement {
      return screen.getByPlaceholderText("輸入家庭同步碼");
    }

    function typeCode(value: string): void {
      fireEvent.change(syncCodeField(), { target: { value } });
    }

    function expectNoNote(): void {
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("sync-code-host-note-invalid"),
      ).not.toBeInTheDocument();
    }

    function expectWarning(): void {
      const warning = screen.getByTestId("sync-code-host-note-invalid");
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning).toHaveTextContent(
        "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
      );
    }

    function advanceSettleDelay(): void {
      act(() => {
        vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows no warning while a legitimate LAN @host is typed one character at a time", () => {
      render(<ControlledIdleView />);

      for (const prefix of HALF_TYPED_PREFIXES) {
        typeCode(prefix);
        expectNoNote();
      }

      // Anchor against a vacuous pass: the same field DOES speak once the value is a complete, adoptable
      // endpoint, so the silence above is the delay at work — not a note that never renders.
      typeCode(LAN_CODE);
      expect(screen.getByTestId("sync-code-host-note")).toBeInTheDocument();
    });

    it("names the endpoint with no delay once the typed @host becomes adoptable", () => {
      render(<ControlledIdleView />);

      typeCode(LAN_CODE);

      // `valid` is positive information about the CURRENT value, so it is never
      // held back — no timer advance here on purpose.
      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        LAN_ENDPOINT,
      );
    });

    it("warns once the typed @host has held still for the settle delay", () => {
      render(<ControlledIdleView />);

      typeCode(SPOOFED_CODE);
      expectNoNote();

      advanceSettleDelay();

      expectWarning();
    });

    it("warns as soon as a pasted code lands, without waiting for the delay", () => {
      render(<ControlledIdleView />);

      // onPaste fires BEFORE the input value updates, so the trigger has to arm
      // the NEXT value rather than settle the (still empty) current one.
      fireEvent.paste(syncCodeField());
      typeCode(SPOOFED_CODE);

      expectWarning();
    });

    it("warns on blur, without waiting for the delay", () => {
      render(<ControlledIdleView />);

      typeCode(SPOOFED_CODE);
      expectNoNote();

      fireEvent.blur(syncCodeField());

      expectWarning();
    });

    it("warns when join is pressed, without waiting for the delay", () => {
      const onJoin = vi.fn();
      render(<ControlledIdleView onJoin={onJoin} />);

      typeCode(SPOOFED_CODE);
      expectNoNote();

      fireEvent.click(screen.getByRole("button", { name: "加入家庭公開書櫃" }));

      expectWarning();
      // Advisory, not a block — pressing join still calls through.
      expect(onJoin).toHaveBeenCalledOnce();
    });

    it("warns immediately for an invite-link prefill present at first render", () => {
      // Trigger 4: a code the user never typed has no typing to flicker through, so it is settled from
      // the first render — the path every other test here uses by passing `syncCodeInput` as a prop.
      render(<IdleView {...defaultProps} syncCodeInput={SPOOFED_CODE} />);

      expectWarning();
    });

    /** If the delay KEPT the last rendered note, appending `@evil.com` would leave a reassuring line over
     *  a spoofed address. See the file header, "Custom-server note timing". */
    it("drops the previously named host the instant the value turns invalid", () => {
      const { container } = render(
        <ControlledIdleView initialSyncCode={TRUSTED_CODE} />,
      );
      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        TRUSTED_ENDPOINT,
      );

      typeCode(SPOOFED_CODE);

      // Before the delay elapses: nothing at all on screen…
      expectNoNote();
      // …and specifically not the host that was legitimate a keystroke ago.
      // (An <input> value never lands in textContent, so this reads the note.)
      expect(container.textContent).not.toContain(TRUSTED_ENDPOINT);

      advanceSettleDelay();

      expectWarning();
    });

    it("leaves no settle timer pending after the view unmounts", () => {
      const { unmount } = render(<ControlledIdleView />);

      typeCode(SPOOFED_CODE);
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("onboarding-view wrapper class", () => {
  // The `moo-onboarding-view` class is pinned onto the root so the padding rule and mobile centering
  // query keep matching real DOM (see the file header, "Styling contract").
  const idleProps: IdleViewProps = {
    state: "idle",
    syncCodeInput: "",
    isProcessing: false,
    onSetSyncCodeInput: vi.fn(),
    onCreate: vi.fn(),
    onJoin: vi.fn(),
  };

  it("WelcomeView renders the moo-onboarding-view wrapper as its root", () => {
    const { container } = render(<WelcomeView onStart={() => {}} />);
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });

  it("CreatedView renders the moo-onboarding-view wrapper as its root", () => {
    const { container } = render(
      <CreatedView
        generatedSyncCode="moo-abc123"
        copied={false}
        onCopy={() => {}}
        onContinue={() => {}}
      />,
    );
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });

  it("ErrorView renders the moo-onboarding-view wrapper as its root", () => {
    const { container } = render(
      <ErrorView
        errorMessage="錯誤"
        actions={[{ label: "重試", onClick: () => {} }]}
      />,
    );
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });

  it("IdleView renders the moo-onboarding-view wrapper as its root", () => {
    const { container } = render(<IdleView {...idleProps} />);
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });
});
