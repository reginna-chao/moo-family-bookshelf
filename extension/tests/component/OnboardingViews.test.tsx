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
    encryptionKey: "keydata",
  }),
}));

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
    generatedSyncCode: "moo-abc123-keydata",
    copied: false,
    onCopy: vi.fn(),
    onContinue: vi.fn(),
  };

  it("renders masked sync code by default", () => {
    render(<CreatedView {...defaultProps} />);

    expect(screen.getByText(/moo-abc123-••••/)).toBeInTheDocument();
    expect(screen.queryByText("moo-abc123-keydata")).not.toBeInTheDocument();
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
    render(<CreatedView {...defaultProps} />);

    const codeEl = screen.getByText(/moo-abc123-••••/);
    expect(codeEl.style.fontFamily).toBe("monospace");
  });

  it("should show full key when eye toggle is clicked", () => {
    render(<CreatedView {...defaultProps} />);

    const toggleBtn = screen.getByRole("button", { name: "顯示同步碼" });
    fireEvent.click(toggleBtn);

    expect(screen.getByText(/moo-abc123-keydata/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隱藏同步碼" })).toBeInTheDocument();
  });
});

describe("ErrorView", () => {
  it("renders error heading with red color", () => {
    render(<ErrorView errorMessage="測試錯誤" onRetry={() => {}} />);

    const heading = screen.getByText("發生錯誤");
    expect(heading).toBeInTheDocument();
    expect(heading.style.color).toBe("rgb(239, 68, 68)");
  });

  it("renders error message text", () => {
    render(<ErrorView errorMessage="伺服器無回應" onRetry={() => {}} />);

    expect(screen.getByText("伺服器無回應")).toBeInTheDocument();
  });

  it("renders retry button", () => {
    render(<ErrorView errorMessage="錯誤" onRetry={() => {}} />);

    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });

  it("calls onRetry when retry button clicked", () => {
    const onRetry = vi.fn();
    render(<ErrorView errorMessage="錯誤" onRetry={onRetry} />);

    fireEvent.click(screen.getByText("重試"));
    expect(onRetry).toHaveBeenCalledOnce();
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

  it("renders encryption notice", () => {
    render(<IdleView {...defaultProps} />);

    expect(screen.getByText(/本工具採端對端加密/)).toBeInTheDocument();
  });

  it("renders '或' separator between create and join", () => {
    render(<IdleView {...defaultProps} />);

    expect(screen.getByText("或")).toBeInTheDocument();
  });

  it("sync code input defaults to password type", () => {
    render(<IdleView {...defaultProps} />);

    const input = screen.getByPlaceholderText("輸入家庭同步碼");
    expect(input).toHaveAttribute("type", "password");
  });

  it("eye toggle switches input between password and text", () => {
    render(<IdleView {...defaultProps} />);

    const input = screen.getByPlaceholderText("輸入家庭同步碼");
    expect(input).toHaveAttribute("type", "password");

    const toggleBtn = screen.getByRole("button", { name: "顯示同步碼" });
    fireEvent.click(toggleBtn);

    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隱藏同步碼" })).toBeInTheDocument();
  });
});
