import { render, screen, fireEvent, act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DisplayNameEditor } from "@/dialog/DisplayNameEditor";
import { useDisplayName } from "@/dialog/useDisplayName";

describe("DisplayNameEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseProps = {
    displayName: "小明",
    savedDisplayName: "小明",
    nameSaveState: "idle" as const,
    nameSaveError: "",
    setDisplayName: vi.fn(),
    handleSaveDisplayName: vi.fn().mockResolvedValue(true),
    userId: "user12345678abcd",
  };

  it("renders label and sub-label", () => {
    render(<DisplayNameEditor {...baseProps} />);

    expect(screen.getByText("顯示名稱")).toBeInTheDocument();
    expect(screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號")).toBeInTheDocument();
  });

  it("shows saved display name in display mode", () => {
    render(<DisplayNameEditor {...baseProps} />);

    expect(screen.getByText("小明")).toBeInTheDocument();
  });

  it("shows userId prefix when no saved display name", () => {
    render(<DisplayNameEditor {...baseProps} savedDisplayName="" displayName="" />);

    expect(screen.getByText("user1234")).toBeInTheDocument();
  });

  it("shows pencil icon button in display mode", () => {
    render(<DisplayNameEditor {...baseProps} />);

    // Display mode: no input visible
    expect(screen.queryByPlaceholderText("輸入顯示名稱")).not.toBeInTheDocument();
  });

  it("enters edit mode on pencil click", () => {
    render(<DisplayNameEditor {...baseProps} />);

    // Click the pencil button (first button in display mode)
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();
  });

  it("input has maxLength of 20 in edit mode", () => {
    render(<DisplayNameEditor {...baseProps} />);

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    const input = screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement;
    expect(input.maxLength).toBe(20);
  });

  it("calls setDisplayName on input change in edit mode", () => {
    const setDisplayName = vi.fn();
    render(<DisplayNameEditor {...baseProps} setDisplayName={setDisplayName} />);

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "大明" },
    });
    expect(setDisplayName).toHaveBeenCalledWith("大明");
  });

  it("calls handleSaveDisplayName on check icon click", async () => {
    const handleSave = vi.fn().mockResolvedValue(true);
    render(
      <DisplayNameEditor
        {...baseProps}
        handleSaveDisplayName={handleSave}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    // Click the check button — wrap in act to handle async state update
    const buttons = screen.getAllByRole("button");
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(handleSave).toHaveBeenCalled();
  });

  it("resets input and exits edit mode on cancel click", () => {
    const setDisplayName = vi.fn();
    render(
      <DisplayNameEditor
        {...baseProps}
        displayName="大明"
        setDisplayName={setDisplayName}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    // Click cancel (X) button — second button after check
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[1]);

    expect(setDisplayName).toHaveBeenCalledWith("小明");
  });

  it("disables buttons during saving state", () => {
    render(<DisplayNameEditor {...baseProps} nameSaveState="saving" />);

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    const buttons = screen.getAllByRole("button");
    // Check and X buttons should be disabled
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
  });

  it("shows error message in edit mode when save failed", () => {
    render(
      <DisplayNameEditor
        {...baseProps}
        nameSaveState="error"
        nameSaveError="名稱過長"
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    expect(screen.getByText("名稱過長")).toBeInTheDocument();
  });

  it("shows error message in edit mode with idle state (error persisted from previous save)", () => {
    render(
      <DisplayNameEditor
        {...baseProps}
        nameSaveState="idle"
        nameSaveError="名稱過長"
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    expect(screen.getByText("名稱過長")).toBeInTheDocument();
  });

  it("stays in edit mode when save fails (returns false)", async () => {
    const handleSave = vi.fn().mockResolvedValue(false);
    render(
      <DisplayNameEditor
        {...baseProps}
        handleSaveDisplayName={handleSave}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);

    // Click check to save — wrap in act to handle async state update
    const buttons = screen.getAllByRole("button");
    await act(async () => {
      fireEvent.click(buttons[0]);
    });

    expect(handleSave).toHaveBeenCalled();
    // Should still be in edit mode — input still visible
    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();
  });

  it("exits edit mode when save succeeds (returns true)", async () => {
    const handleSave = vi.fn().mockResolvedValue(true);
    render(
      <DisplayNameEditor
        {...baseProps}
        handleSaveDisplayName={handleSave}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();

    // Click check to save — wrap in act to handle async state update
    const buttons = screen.getAllByRole("button");
    await act(async () => {
      fireEvent.click(buttons[0]);
    });

    expect(handleSave).toHaveBeenCalled();
    // Should exit edit mode — input gone
    expect(screen.queryByPlaceholderText("輸入顯示名稱")).not.toBeInTheDocument();
  });

  it("disables input field during saving state", () => {
    render(<DisplayNameEditor {...baseProps} nameSaveState="saving" />);

    fireEvent.click(screen.getAllByRole("button")[0]);

    const input = screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement;
    expect(input).toBeDisabled();
  });

  it("does not call handleSaveDisplayName on Enter when already saving", () => {
    const handleSave = vi.fn();
    render(
      <DisplayNameEditor
        {...baseProps}
        nameSaveState="saving"
        handleSaveDisplayName={handleSave}
      />,
    );

    fireEvent.click(screen.getAllByRole("button")[0]);

    const input = screen.getByPlaceholderText("輸入顯示名稱");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(handleSave).not.toHaveBeenCalled();
  });

  it("does not call handleSaveDisplayName on submit click when already saving", () => {
    const handleSave = vi.fn();
    render(
      <DisplayNameEditor
        {...baseProps}
        nameSaveState="saving"
        handleSaveDisplayName={handleSave}
      />,
    );

    fireEvent.click(screen.getAllByRole("button")[0]);

    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(handleSave).not.toHaveBeenCalled();
  });
});

describe("useDisplayName in-flight guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls storage.local.set only once when handleSaveDisplayName is invoked twice concurrently", async () => {
    const { result } = renderHook(() => useDisplayName());

    // Flush the initial chrome.storage.local.get in useEffect
    await act(async () => {});

    // Fire both calls without awaiting between them — second should be blocked by inFlightRef
    let p1: Promise<boolean>;
    let p2: Promise<boolean>;
    await act(async () => {
      p1 = result.current.handleSaveDisplayName();
      p2 = result.current.handleSaveDisplayName();
      await Promise.all([p1!, p2!]);
    });

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });
});
