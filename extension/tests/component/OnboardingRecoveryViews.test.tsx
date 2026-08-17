import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SYNC_CODE_HOST_SETTLE_DELAY_MS } from "moo-family-bookshelf-shared/api/syncCodeHost";
import {
  RecoveryChoiceView,
  RecoveryJoinView,
  SoloRecoveryConfirmView,
} from "@/dialog/OnboardingRecoveryViews";
import {
  HALF_TYPED_PREFIXES,
  LAN_CODE,
  LAN_ENDPOINT,
  SPOOFED_CODE,
  TRUSTED_CODE,
  TRUSTED_ENDPOINT,
} from "../helpers/syncCodeHostFixtures";

describe("RecoveryChoiceView", () => {
  const defaultProps = {
    userEmail: "user@example.com",
    onUseSyncCode: vi.fn(),
    onSkip: vi.fn(),
  };

  it("renders heading", () => {
    render(<RecoveryChoiceView {...defaultProps} />);

    expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
  });

  it("displays userEmail when provided", () => {
    render(<RecoveryChoiceView {...defaultProps} />);

    expect(screen.getByText("帳號：user@example.com")).toBeInTheDocument();
  });

  it("omits email line when userEmail is empty", () => {
    render(<RecoveryChoiceView {...defaultProps} userEmail="" />);

    expect(screen.queryByText(/帳號：/)).not.toBeInTheDocument();
  });

  it("renders explanation about recovery options", () => {
    render(<RecoveryChoiceView {...defaultProps} />);

    expect(screen.getByText(/自動恢復未成功/)).toBeInTheDocument();
  });

  it("renders both primary and secondary action buttons", () => {
    render(<RecoveryChoiceView {...defaultProps} />);

    expect(
      screen.getByRole("button", { name: "輸入同步碼重新加入" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "略過，重新同步書籍資料" }),
    ).toBeInTheDocument();
  });

  it("calls onUseSyncCode when '輸入同步碼' is clicked", () => {
    const onUseSyncCode = vi.fn();
    const onSkip = vi.fn();
    render(
      <RecoveryChoiceView
        {...defaultProps}
        onUseSyncCode={onUseSyncCode}
        onSkip={onSkip}
      />,
    );

    fireEvent.click(screen.getByText("輸入同步碼重新加入"));

    expect(onUseSyncCode).toHaveBeenCalledOnce();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("calls onSkip when '略過' is clicked", () => {
    const onUseSyncCode = vi.fn();
    const onSkip = vi.fn();
    render(
      <RecoveryChoiceView
        {...defaultProps}
        onUseSyncCode={onUseSyncCode}
        onSkip={onSkip}
      />,
    );

    fireEvent.click(screen.getByText("略過，重新同步書籍資料"));

    expect(onSkip).toHaveBeenCalledOnce();
    expect(onUseSyncCode).not.toHaveBeenCalled();
  });
});

describe("RecoveryJoinView", () => {
  const defaultProps = {
    syncCodeInput: "",
    isProcessing: false,
    onSetSyncCodeInput: vi.fn(),
    onJoin: vi.fn(),
    onBack: vi.fn(),
  };

  it("renders heading and description", () => {
    render(<RecoveryJoinView {...defaultProps} />);

    expect(screen.getByText("輸入同步碼")).toBeInTheDocument();
    expect(
      screen.getByText(/請輸入家庭同步碼以重新加入家庭/),
    ).toBeInTheDocument();
  });

  it("renders sync code input with password type by default", () => {
    render(<RecoveryJoinView {...defaultProps} />);

    const input = screen.getByPlaceholderText("輸入家庭同步碼");
    expect(input).toHaveAttribute("type", "password");
  });

  it("eye toggle switches input between password and text", () => {
    render(<RecoveryJoinView {...defaultProps} />);

    const input = screen.getByPlaceholderText("輸入家庭同步碼");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "顯示同步碼" }));

    expect(input).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "隱藏同步碼" }),
    ).toBeInTheDocument();
  });

  it("calls onSetSyncCodeInput on input change", () => {
    const onSetSyncCodeInput = vi.fn();
    render(
      <RecoveryJoinView
        {...defaultProps}
        onSetSyncCodeInput={onSetSyncCodeInput}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
      target: { value: "moo-new-code" },
    });

    expect(onSetSyncCodeInput).toHaveBeenCalledWith("moo-new-code");
  });

  it("disables join button when syncCodeInput is empty", () => {
    render(<RecoveryJoinView {...defaultProps} syncCodeInput="" />);

    expect(
      screen.getByRole("button", { name: "加入並還原書架" }),
    ).toBeDisabled();
  });

  it("disables join button when syncCodeInput is whitespace only", () => {
    render(<RecoveryJoinView {...defaultProps} syncCodeInput="   " />);

    expect(
      screen.getByRole("button", { name: "加入並還原書架" }),
    ).toBeDisabled();
  });

  it("enables join button when syncCodeInput has content", () => {
    render(
      <RecoveryJoinView {...defaultProps} syncCodeInput="moo-test-code" />,
    );

    expect(
      screen.getByRole("button", { name: "加入並還原書架" }),
    ).toBeEnabled();
  });

  it("calls onJoin when join button is clicked", () => {
    const onJoin = vi.fn();
    render(
      <RecoveryJoinView
        {...defaultProps}
        syncCodeInput="moo-test-code"
        onJoin={onJoin}
      />,
    );

    fireEvent.click(screen.getByText("加入並還原書架"));

    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("calls onBack when back button is clicked", () => {
    const onBack = vi.fn();
    render(<RecoveryJoinView {...defaultProps} onBack={onBack} />);

    fireEvent.click(screen.getByText("返回"));

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows '加入中...' label and disables join when isProcessing is true", () => {
    render(
      <RecoveryJoinView
        {...defaultProps}
        syncCodeInput="moo-test-code"
        isProcessing={true}
      />,
    );

    expect(screen.getByText("加入中...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加入中..." })).toBeDisabled();
  });

  it("disables input and back button when isProcessing is true", () => {
    render(
      <RecoveryJoinView
        {...defaultProps}
        syncCodeInput="moo-test-code"
        isProcessing={true}
      />,
    );

    expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();
  });

  // The recovery path accepts the same @host codes as onboarding, so it names
  // the server the code points at before the user rejoins.
  it("names the host while a sync code carrying @host is typed", () => {
    render(
      <RecoveryJoinView
        {...defaultProps}
        syncCodeInput="moo-ab12-cd34@https://custom.example.com"
      />,
    );

    const note = screen.getByTestId("sync-code-host-note");
    expect(note).toHaveTextContent("此同步碼將連線至自訂伺服器：");
    // The canonical endpoint — what the join path would actually adopt.
    expect(note).toHaveTextContent("https://custom.example.com");
  });

  it("shows the canonical endpoint, not the raw @host segment", () => {
    render(
      <RecoveryJoinView
        {...defaultProps}
        syncCodeInput="moo-ab12-cd34@https://CUSTOM.Example.COM:443/api"
      />,
    );

    const note = screen.getByTestId("sync-code-host-note");
    expect(note).toHaveTextContent("https://custom.example.com/api");
    expect(note.textContent).not.toContain("CUSTOM.Example.COM");
    expect(note.textContent).not.toContain(":443");
  });

  it("shows no host note for a default-endpoint sync code", () => {
    render(
      <RecoveryJoinView {...defaultProps} syncCodeInput="moo-ab12-cd34" />,
    );

    expect(screen.queryByTestId("sync-code-host-note")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sync-code-host-note-invalid"),
    ).not.toBeInTheDocument();
  });

  /**
   * Recovery is the screen a user reaches when something already went wrong, so
   * a spoofed `@host` must be called out here too rather than presented as the
   * server they are about to hand their book list to.
   */
  it("warns instead of naming the host when the @host would be refused", () => {
    render(
      <RecoveryJoinView
        {...defaultProps}
        syncCodeInput="moo-ab12-cd34@https://real.example@evil.com"
      />,
    );

    const warning = screen.getByTestId("sync-code-host-note-invalid");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(
      "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
    );
    expect(screen.queryByTestId("sync-code-host-note")).not.toBeInTheDocument();
    expect(warning.textContent).not.toContain("real.example");
  });

  it.each([
    // Bare hosts were ALWAYS refused at adoption (`new URL()` needs a scheme).
    ["a bare host with no scheme", "moo-ab12-cd34@my-worker.example.com"],
    ["plain HTTP on a public host", "moo-ab12-cd34@http://evil.example.com"],
  ])("warns about %s", (_label, syncCodeInput) => {
    render(
      <RecoveryJoinView {...defaultProps} syncCodeInput={syncCodeInput} />,
    );

    expect(
      screen.getByTestId("sync-code-host-note-invalid"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("sync-code-host-note")).not.toBeInTheDocument();
  });

  /**
   * WHEN the warning may appear, as opposed to what it says. The recovery join
   * screen runs the same delayed-disclosure hook as onboarding, so it gets the
   * same coverage: the warning may be held back until the value settles, never
   * suppressed, and never replaced by a note that contradicts the field.
   *
   * Mirrors the IdleView block in
   * extension/tests/component/OnboardingViews.test.tsx.
   */
  describe("custom-server note timing", () => {
    /**
     * RecoveryJoinView is controlled by dialog/Onboarding.tsx, so a stateful
     * wrapper is what lets these tests drive the real input → onChange → prop
     * round trip (and with it the onPaste / onBlur handlers).
     */
    function ControlledRecoveryJoinView({
      initialSyncCode = "",
      onJoin = () => {},
    }: {
      initialSyncCode?: string;
      onJoin?: () => void;
    }) {
      const [syncCodeInput, setSyncCodeInput] = useState(initialSyncCode);
      return (
        <RecoveryJoinView
          syncCodeInput={syncCodeInput}
          isProcessing={false}
          onSetSyncCodeInput={setSyncCodeInput}
          onJoin={onJoin}
          onBack={() => {}}
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
      render(<ControlledRecoveryJoinView />);

      for (const prefix of HALF_TYPED_PREFIXES) {
        typeCode(prefix);
        expectNoNote();
      }

      // Anchor against a vacuous pass: the same field DOES speak once the value
      // is a complete, adoptable endpoint, so the silence above is the delay
      // doing its job — not a note that never renders at all.
      typeCode(LAN_CODE);
      expect(screen.getByTestId("sync-code-host-note")).toBeInTheDocument();
    });

    it("names the endpoint with no delay once the typed @host becomes adoptable", () => {
      render(<ControlledRecoveryJoinView />);

      typeCode(LAN_CODE);

      // `valid` describes the CURRENT value, so it is never held back.
      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        LAN_ENDPOINT,
      );
    });

    it("warns once the typed @host has held still for the settle delay", () => {
      render(<ControlledRecoveryJoinView />);

      typeCode(SPOOFED_CODE);
      expectNoNote();

      advanceSettleDelay();

      expectWarning();
    });

    it("warns as soon as a pasted code lands, without waiting for the delay", () => {
      render(<ControlledRecoveryJoinView />);

      fireEvent.paste(syncCodeField());
      typeCode(SPOOFED_CODE);

      expectWarning();
    });

    it("warns on blur, without waiting for the delay", () => {
      render(<ControlledRecoveryJoinView />);

      typeCode(SPOOFED_CODE);
      expectNoNote();

      fireEvent.blur(syncCodeField());

      expectWarning();
    });

    it("warns when join is pressed, without waiting for the delay", () => {
      const onJoin = vi.fn();
      render(<ControlledRecoveryJoinView onJoin={onJoin} />);

      typeCode(SPOOFED_CODE);
      expectNoNote();

      fireEvent.click(screen.getByRole("button", { name: "加入並還原書架" }));

      expectWarning();
      expect(onJoin).toHaveBeenCalledOnce();
    });

    it("warns immediately for an invite-link prefill present at first render", () => {
      // Trigger 4: a code the user never typed is settled from the first render.
      render(
        <RecoveryJoinView {...defaultProps} syncCodeInput={SPOOFED_CODE} />,
      );

      expectWarning();
    });

    /**
     * Appending `@evil.com` to a host the user already saw named must remove
     * that name at once. A note kept alive across the change would lend the
     * spoofed address the legitimacy of the host it replaced.
     */
    it("drops the previously named host the instant the value turns invalid", () => {
      const { container } = render(
        <ControlledRecoveryJoinView initialSyncCode={TRUSTED_CODE} />,
      );
      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        TRUSTED_ENDPOINT,
      );

      typeCode(SPOOFED_CODE);

      expectNoNote();
      // An <input> value never lands in textContent, so this reads the note.
      expect(container.textContent).not.toContain(TRUSTED_ENDPOINT);

      advanceSettleDelay();

      expectWarning();
    });

    it("leaves no settle timer pending after the view unmounts", () => {
      const { unmount } = render(<ControlledRecoveryJoinView />);

      typeCode(SPOOFED_CODE);
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("SoloRecoveryConfirmView", () => {
  const defaultProps = {
    onConfirm: vi.fn(),
    onBack: vi.fn(),
  };

  it("renders confirmation heading", () => {
    render(<SoloRecoveryConfirmView {...defaultProps} />);

    expect(screen.getByText("確認重新同步書籍資料？")).toBeInTheDocument();
  });

  it("renders info about sync and settings preservation", () => {
    render(<SoloRecoveryConfirmView {...defaultProps} />);

    expect(
      screen.getByText(/將以目前的讀墨帳號重新同步書籍資料/),
    ).toBeInTheDocument();
    expect(screen.getByText(/分享設定.*會自動保留/)).toBeInTheDocument();
  });

  it("renders note about sync completion", () => {
    render(<SoloRecoveryConfirmView {...defaultProps} />);

    expect(screen.getByText(/同步完成後即可查看家庭書架/)).toBeInTheDocument();
  });

  it("renders confirm and back buttons", () => {
    render(<SoloRecoveryConfirmView {...defaultProps} />);

    expect(
      screen.getByRole("button", { name: "確認重新同步" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();
    render(
      <SoloRecoveryConfirmView
        {...defaultProps}
        onConfirm={onConfirm}
        onBack={onBack}
      />,
    );

    fireEvent.click(screen.getByText("確認重新同步"));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("calls onBack when back button is clicked", () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();
    render(
      <SoloRecoveryConfirmView
        {...defaultProps}
        onConfirm={onConfirm}
        onBack={onBack}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
