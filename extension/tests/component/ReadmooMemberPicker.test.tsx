import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReadmooMemberPicker } from "@/dialog/ReadmooMemberPicker";
import type { ReadmooMember } from "@/content/readmoo-lend";

const ALICE: ReadmooMember = { name: "Alice", avatar: "alice.png" };
const BOB: ReadmooMember = { name: "Bob", avatar: "bob.png" };

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof ReadmooMemberPicker>> = {},
) {
  const props: React.ComponentProps<typeof ReadmooMemberPicker> = {
    borrowerName: "小明",
    options: [ALICE, BOB],
    saving: false,
    errorMessage: null,
    onPick: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const utils = render(<ReadmooMemberPicker {...props} />);
  return { ...utils, props };
}

describe("ReadmooMemberPicker", () => {
  it("renders the borrower name in the title", () => {
    renderPicker({ borrowerName: "小明" });
    expect(
      screen.getByText(/請選擇「小明」對應的讀墨家庭成員/),
    ).toBeInTheDocument();
  });

  it("renders one button per option with the member name", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: /Alice/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bob/ })).toBeInTheDocument();
  });

  it("invokes onPick with the chosen member when a row is clicked", () => {
    const onPick = vi.fn();
    renderPicker({ onPick });
    fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
    expect(onPick).toHaveBeenCalledWith(BOB);
  });

  it("invokes onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("invokes onCancel when the close (X) button is clicked", () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: "關閉" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("invokes onCancel when Escape is pressed", () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables all interactions while saving and shows 處理中... on cancel", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    renderPicker({ saving: true, onPick, onCancel });
    const pickBtn = screen.getByRole("button", { name: /Alice/ });
    const cancelBtn = screen.getByRole("button", { name: /處理中/ });
    expect(pickBtn).toBeDisabled();
    expect(cancelBtn).toBeDisabled();
    fireEvent.click(pickBtn);
    fireEvent.click(cancelBtn);
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not call onCancel via Escape while saving", () => {
    const onCancel = vi.fn();
    renderPicker({ saving: true, onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("surfaces errorMessage in a role=alert region", () => {
    renderPicker({ errorMessage: "儲存失敗，請重試" });
    expect(screen.getByRole("alert")).toHaveTextContent("儲存失敗，請重試");
  });

  it("shows an empty state when no options are available", () => {
    renderPicker({ options: [] });
    expect(
      screen.getByText("讀墨清單中沒有可選的家庭成員。"),
    ).toBeInTheDocument();
  });

  it("removes the keydown listener on unmount", () => {
    const onCancel = vi.fn();
    const { unmount } = renderPicker({ onCancel });
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
