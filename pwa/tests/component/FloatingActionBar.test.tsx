import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FloatingActionBar } from "@/components/FloatingActionBar";

/**
 * FloatingActionBar — the save / cancel-changes section (#250).
 *
 * A save can now succeed while a toggle made mid-save stays unsaved, so the bar
 * can see `isSaved && isDirty`. It must not call that state saved, and 取消變更
 * must stay locked while a save is in flight (parity with the Extension).
 */

interface BarState {
  isDirty: boolean;
  isSaving: boolean;
  isSaved: boolean;
}

function renderBar(state: BarState) {
  const handlers = {
    onBatchShare: vi.fn(),
    onBatchHide: vi.fn(),
    onCancelChanges: vi.fn(),
    onSave: vi.fn(),
  };
  render(<FloatingActionBar selectedCount={0} {...state} {...handlers} />);
  return handlers;
}

describe("FloatingActionBar", () => {
  describe("save button", () => {
    it("offers 儲存變更, enabled, when a save succeeded but changes are still unsaved", () => {
      const { onSave } = renderBar({
        isDirty: true,
        isSaving: false,
        isSaved: true,
      });

      const save = screen.getByRole("button", { name: "儲存變更" });
      expect(save).toBeEnabled();
      expect(screen.queryByText("已儲存")).not.toBeInTheDocument();

      fireEvent.click(save);
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("shows 已儲存, disabled, when a save succeeded and nothing is unsaved", () => {
      renderBar({ isDirty: false, isSaving: false, isSaved: true });

      expect(screen.getByRole("button", { name: "已儲存" })).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "儲存變更" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("取消變更 button", () => {
    it("is disabled while a save is in flight and ignores clicks", () => {
      const { onCancelChanges } = renderBar({
        isDirty: true,
        isSaving: true,
        isSaved: false,
      });

      const cancel = screen.getByRole("button", { name: "取消變更" });
      expect(cancel).toBeDisabled();

      fireEvent.click(cancel);
      expect(onCancelChanges).not.toHaveBeenCalled();
    });

    it("is enabled when dirty and not saving, and calls onCancelChanges", () => {
      const { onCancelChanges } = renderBar({
        isDirty: true,
        isSaving: false,
        isSaved: false,
      });

      const cancel = screen.getByRole("button", { name: "取消變更" });
      expect(cancel).toBeEnabled();

      fireEvent.click(cancel);
      expect(onCancelChanges).toHaveBeenCalledTimes(1);
    });
  });
});
