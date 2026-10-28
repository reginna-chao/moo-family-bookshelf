/**
 * FloatingActionBar — the save button label (#250, #387).
 *
 * The bar stays up for the brief "saved" window after a save succeeds, and
 * then reads 已儲存 (disabled). A save can succeed while a toggle made
 * mid-save stays unsaved (`isSaved && isDirty`): that state must never read
 * 已儲存 and must still offer an enabled 儲存變更. Parity with
 * `pwa/tests/component/FloatingActionBar.test.tsx`.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { FloatingActionBar } from "@/dialog/FloatingActionBar";

function renderBar(state: {
  selectedCount?: number;
  isDirty: boolean;
  isSaving: boolean;
  isSaved?: boolean;
}) {
  const handlers = {
    onBatchShare: vi.fn(),
    onBatchHide: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
  };
  render(
    <FloatingActionBar
      selectedCount={state.selectedCount ?? 0}
      isDirty={state.isDirty}
      isSaving={state.isSaving}
      isSaved={state.isSaved ?? false}
      {...handlers}
    />,
  );
  return handlers;
}

describe("FloatingActionBar", () => {
  it("exposes the bar as a toolbar named 批次操作工具列", () => {
    renderBar({ isDirty: true, isSaving: false });

    expect(
      screen.getByRole("toolbar", { name: "批次操作工具列" }),
    ).toBeInTheDocument();
  });

  it("offers 儲存變更, enabled, while dirty and not saving", () => {
    const { onSave } = renderBar({ isDirty: true, isSaving: false });

    const save = screen.getByRole("button", { name: "儲存變更" });
    expect(save).toBeEnabled();

    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows 儲存中..., disabled, while a save is in flight", () => {
    renderBar({ isDirty: true, isSaving: true });

    expect(screen.getByRole("button", { name: "儲存中..." })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "儲存變更" }),
    ).not.toBeInTheDocument();
  });

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
    renderBar({
      selectedCount: 0,
      isDirty: false,
      isSaving: false,
      isSaved: true,
    });

    expect(screen.getByRole("button", { name: "已儲存" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "儲存變更" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消變更" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { selectedCount: 0, isDirty: true, isSaving: false },
    { selectedCount: 0, isDirty: true, isSaving: true },
    { selectedCount: 2, isDirty: true, isSaving: false },
    { selectedCount: 2, isDirty: false, isSaving: false },
  ])("never renders 已儲存 while isSaved is false (%o)", (state) => {
    renderBar({ ...state, isSaved: false });

    // Positive companion: the bar did render for this state.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(screen.queryByText("已儲存")).not.toBeInTheDocument();
  });
});
