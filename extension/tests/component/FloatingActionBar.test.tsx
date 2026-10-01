/**
 * FloatingActionBar — the save button label (#250).
 *
 * The bar only renders while there is a selection or unsaved changes, so it
 * never calls anything "saved": a save that leaves mid-save toggles unsaved
 * must still offer 儲存變更.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { FloatingActionBar } from "@/dialog/FloatingActionBar";

function renderBar(state: {
  selectedCount?: number;
  isDirty: boolean;
  isSaving: boolean;
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
      {...handlers}
    />,
  );
  return handlers;
}

describe("FloatingActionBar", () => {
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

  it.each([
    { selectedCount: 0, isDirty: true, isSaving: false },
    { selectedCount: 0, isDirty: true, isSaving: true },
    { selectedCount: 2, isDirty: true, isSaving: false },
    { selectedCount: 2, isDirty: false, isSaving: false },
  ])("never renders 已儲存 (%o)", (state) => {
    renderBar(state);

    // Positive companion: the bar did render for this state.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(screen.queryByText("已儲存")).not.toBeInTheDocument();
  });
});
