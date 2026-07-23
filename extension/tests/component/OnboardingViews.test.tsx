import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  WelcomeView,
  CreatedView,
  ErrorView,
  IdleView,
} from "@/dialog/OnboardingViews";

vi.mock("@/crypto/syncCode", () => ({
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
    expect(screen.getByText("一鍵開始，自動同步你的讀墨帳號與書單。")).toBeInTheDocument();
  });

  it("renders start button", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(screen.getByRole("button", { name: "開始使用" })).toBeInTheDocument();
  });

  it("calls onStart when button is clicked", () => {
    const onStart = vi.fn();
    render(<WelcomeView onStart={onStart} />);

    fireEvent.click(screen.getByText("開始使用"));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("renders privacy notice", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(screen.getByText(/我們僅讀取你的帳號信箱用於生成匿名識別碼/)).toBeInTheDocument();
  });

  it("renders '繼續使用' button when hasUsedBefore is true", () => {
    render(<WelcomeView onStart={() => {}} hasUsedBefore={true} />);

    expect(screen.getByRole("button", { name: "繼續使用" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "開始使用" })).not.toBeInTheDocument();
  });

  it("renders recovery subtitle when hasUsedBefore is true", () => {
    render(<WelcomeView onStart={() => {}} hasUsedBefore={true} />);

    expect(screen.getByText("偵測到你曾使用過家庭書櫃，請重新設定以繼續。")).toBeInTheDocument();
    expect(screen.queryByText("一鍵開始，自動同步你的讀墨帳號與書單。")).not.toBeInTheDocument();
  });

  it("renders default text when hasUsedBefore is false", () => {
    render(<WelcomeView onStart={() => {}} hasUsedBefore={false} />);

    expect(screen.getByRole("button", { name: "開始使用" })).toBeInTheDocument();
    expect(screen.getByText("一鍵開始，自動同步你的讀墨帳號與書單。")).toBeInTheDocument();
  });

  it("renders default text when hasUsedBefore is undefined", () => {
    render(<WelcomeView onStart={() => {}} />);

    expect(screen.getByRole("button", { name: "開始使用" })).toBeInTheDocument();
    expect(screen.getByText("一鍵開始，自動同步你的讀墨帳號與書單。")).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "複製同步碼" })).toBeInTheDocument();
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
    // After the Shadow DOM + scoped-CSS conversion the monospace font moved from
    // an inline style to `.moo-onboarding-view__code-text` in styles.css. jsdom
    // does not apply stylesheet rules, so the observable contract is now the class.
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
    // The red color moved from an inline style to the `--error` heading modifier
    // in styles.css. jsdom does not apply stylesheet rules, so assert the base
    // heading class plus the error modifier that carries the danger color.
    render(<ErrorView errorMessage="測試錯誤" actions={[{ label: "重試", onClick: () => {} }]} />);

    const heading = screen.getByText("發生錯誤");
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveClass("moo-onboarding-view__heading");
    expect(heading).toHaveClass("moo-onboarding-view__heading--error");
  });

  it("renders error message text", () => {
    render(<ErrorView errorMessage="伺服器無回應" actions={[{ label: "重試", onClick: () => {} }]} />);

    expect(screen.getByText("伺服器無回應")).toBeInTheDocument();
  });

  it("renders single action button", () => {
    render(<ErrorView errorMessage="錯誤" actions={[{ label: "重試", onClick: () => {} }]} />);

    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("calls onClick when action button is clicked", () => {
    const onClick = vi.fn();
    render(<ErrorView errorMessage="錯誤" actions={[{ label: "重試", onClick }]} />);

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

    expect(screen.getByRole("button", { name: "改用同步碼" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("primary variant renders filled blue button", () => {
    // The filled-blue vs outlined styling moved from inline styles to scoped
    // classes in styles.css. jsdom does not apply stylesheet rules, so the
    // observable contract is the primary class (and the absence of secondary).
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
    // Outlined (transparent bg + blue border) styling now lives in the
    // `moo-onboarding-view__secondary` class. Assert the secondary class is
    // present and the primary class is absent so the two variants stay distinct.
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
  const defaultProps = {
    state: "idle" as string,
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

    expect(screen.getByRole("button", { name: "建立家庭公開書櫃" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "加入家庭公開書櫃" })).toBeInTheDocument();
  });

  it("join button is disabled when sync code input is empty", () => {
    render(<IdleView {...defaultProps} syncCodeInput="" />);

    expect(screen.getByRole("button", { name: "加入家庭公開書櫃" })).toBeDisabled();
  });

  it("join button is enabled when sync code input has text", () => {
    render(<IdleView {...defaultProps} syncCodeInput="moo-test-code" />);

    expect(screen.getByRole("button", { name: "加入家庭公開書櫃" })).toBeEnabled();
  });

  it("calls onJoin when join button clicked", () => {
    const onJoin = vi.fn();
    render(
      <IdleView {...defaultProps} syncCodeInput="moo-test-code" onJoin={onJoin} />,
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

    expect(screen.getByRole("button", { name: "建立家庭公開書櫃" })).toBeDisabled();
  });

  it("disables join button when isProcessing is true", () => {
    render(
      <IdleView {...defaultProps} syncCodeInput="moo-test" isProcessing={true} />,
    );

    expect(screen.getByRole("button", { name: "加入家庭公開書櫃" })).toBeDisabled();
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
});

describe("onboarding-view wrapper class", () => {
  // The restored `.moo-onboarding-view { padding: 24px }` rule and the mobile
  // centering media query both target the `moo-onboarding-view` wrapper. These
  // assertions pin the class onto the rendered root so the CSS selectors keep
  // matching real DOM (jsdom cannot verify the padding itself).
  const idleProps = {
    state: "idle" as string,
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
      <ErrorView errorMessage="錯誤" actions={[{ label: "重試", onClick: () => {} }]} />,
    );
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });

  it("IdleView renders the moo-onboarding-view wrapper as its root", () => {
    const { container } = render(<IdleView {...idleProps} />);
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });
});
