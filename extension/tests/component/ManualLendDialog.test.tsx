import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { ManualLendDialog } from "@/dialog/ManualLendDialog";

interface RenderOptions {
  dontRemindChecked?: boolean;
  confirming?: boolean;
}

function renderDialog(options: RenderOptions = {}) {
  const onDontRemindChange = vi.fn();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ManualLendDialog
      dontRemindChecked={options.dontRemindChecked ?? false}
      onDontRemindChange={onDontRemindChange}
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirming={options.confirming}
    />,
  );
  return { onDontRemindChange, onConfirm, onCancel };
}

describe("ManualLendDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title, both body paragraphs, checkbox, and action buttons", () => {
    renderDialog();

    expect(screen.getByText("手動借出提醒")).toBeInTheDocument();
    expect(
      screen.getByText(
        "此操作後將會通知對方已借出，但需要手動方式完成借書流程。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "請自行前往讀墨網頁或 APP，從『我的書櫃』找到此書並手動借出給對方。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("不再顯示此通知")).toBeInTheDocument();
    expect(screen.getByText("取消")).toBeInTheDocument();
    expect(screen.getByText("確認借出")).toBeInTheDocument();
  });

  it("exposes a dialog role with aria-modal and a close button", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "手動借出提醒");
    expect(screen.getByLabelText("關閉")).toBeInTheDocument();
  });

  it("calls onDontRemindChange(true) when the checkbox is checked", () => {
    const { onDontRemindChange } = renderDialog({ dontRemindChecked: false });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onDontRemindChange).toHaveBeenCalledWith(true);
  });

  it("reflects dontRemindChecked in the checkbox state", () => {
    renderDialog({ dontRemindChecked: true });
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("calls onConfirm when 確認借出 is clicked", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByText("確認借出"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when 取消 is clicked", () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByText("取消"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the close (X) button is clicked", () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByLabelText("關閉"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape is pressed", () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables buttons and shows 處理中... when confirming", () => {
    renderDialog({ confirming: true });

    expect(screen.getByText("處理中...")).toBeInTheDocument();
    expect(screen.queryByText("確認借出")).not.toBeInTheDocument();
    expect(screen.getByText("取消")).toBeDisabled();
    expect(screen.getByText("處理中...")).toBeDisabled();
  });

  it("does not call onCancel on Escape while confirming", () => {
    const { onCancel } = renderDialog({ confirming: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
