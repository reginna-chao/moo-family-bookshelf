import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DisplayNameEditor } from "@/dialog/DisplayNameEditor";

describe("DisplayNameEditor", () => {
  const baseProps = {
    displayName: "小明",
    savedDisplayName: "小明",
    nameSaveState: "idle" as const,
    nameSaveError: "",
    setDisplayName: vi.fn(),
    handleSaveDisplayName: vi.fn().mockResolvedValue(undefined),
  };

  it("renders label and sub-label", () => {
    render(<DisplayNameEditor {...baseProps} />);

    expect(screen.getByText("顯示名稱")).toBeInTheDocument();
    expect(screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號")).toBeInTheDocument();
  });

  it("shows current display name in input", () => {
    render(<DisplayNameEditor {...baseProps} />);

    const input = screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement;
    expect(input.value).toBe("小明");
  });

  it("input has maxLength of 20", () => {
    render(<DisplayNameEditor {...baseProps} />);

    const input = screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement;
    expect(input.maxLength).toBe(20);
  });

  it("save button disabled when name unchanged", () => {
    render(<DisplayNameEditor {...baseProps} />);

    expect(screen.getByText("儲存")).toBeDisabled();
  });

  it("save button enabled when name changed", () => {
    render(<DisplayNameEditor {...baseProps} displayName="大明" />);

    expect(screen.getByText("儲存")).toBeEnabled();
  });

  it("calls setDisplayName on input change", () => {
    const setDisplayName = vi.fn();
    render(<DisplayNameEditor {...baseProps} setDisplayName={setDisplayName} />);

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "大明" },
    });
    expect(setDisplayName).toHaveBeenCalledWith("大明");
  });

  it("calls handleSaveDisplayName on save click", () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DisplayNameEditor
        {...baseProps}
        displayName="大明"
        handleSaveDisplayName={handleSave}
      />,
    );

    fireEvent.click(screen.getByText("儲存"));
    expect(handleSave).toHaveBeenCalled();
  });

  it("shows saving state", () => {
    render(<DisplayNameEditor {...baseProps} nameSaveState="saving" />);

    expect(screen.getByText("儲存中...")).toBeInTheDocument();
  });

  it("shows saved state", () => {
    render(<DisplayNameEditor {...baseProps} nameSaveState="saved" />);

    expect(screen.getByText("已儲存")).toBeInTheDocument();
  });

  it("shows error state and message", () => {
    render(
      <DisplayNameEditor
        {...baseProps}
        nameSaveState="error"
        nameSaveError="名稱過長"
      />,
    );

    expect(screen.getByText("儲存失敗")).toBeInTheDocument();
    expect(screen.getByText("名稱過長")).toBeInTheDocument();
  });
});
