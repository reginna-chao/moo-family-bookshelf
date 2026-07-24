import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  RecoveryChoiceView,
  RecoveryJoinView,
  SoloRecoveryConfirmView,
} from "@/dialog/OnboardingRecoveryViews";

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
