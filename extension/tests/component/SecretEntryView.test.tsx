import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PatternView, PinView } from "@/secureFrame/views/SecretEntryView";

/**
 * The secure frame's `pin` / `pattern` views (#363): the unchanged `PinInput` / `PatternLock` with
 * their `onComplete` turned into a `submit` message, and focus taken on the first props only when
 * the host passed `autoFocus` (every Dialog call site leaves it off, matching the pre-#363 fields).
 * The full widget behaviour stays in `PinInput.test.tsx` / `PatternLock.test.tsx`.
 */

describe("PinView", () => {
  it("emits the confirmed PIN as `submit`", () => {
    const emit = vi.fn();
    render(<PinView props={{ mode: "verify" }} emit={emit} />);
    fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認" }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ type: "submit", secret: "654321" });
  });

  it("forwards the error and the disabled state", () => {
    render(
      <PinView
        props={{ mode: "verify", error: "PIN 錯誤", disabled: true }}
        emit={vi.fn()}
      />,
    );
    expect(screen.getByText("PIN 錯誤")).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toBeDisabled();
  });

  it("focuses the PIN field when the first props ask for it", () => {
    render(
      <PinView props={{ mode: "verify", autoFocus: true }} emit={vi.fn()} />,
    );
    expect(screen.getByLabelText("PIN 碼輸入")).toHaveFocus();
  });

  it("does not take focus by default, nor on a later autoFocus", () => {
    const { rerender } = render(
      <PinView props={{ mode: "verify" }} emit={vi.fn()} />,
    );
    expect(screen.getByLabelText("PIN 碼輸入")).not.toHaveFocus();
    rerender(
      <PinView props={{ mode: "verify", autoFocus: true }} emit={vi.fn()} />,
    );
    expect(screen.getByLabelText("PIN 碼輸入")).not.toHaveFocus();
  });
});

describe("PatternView", () => {
  it("focuses its wrapper when the first props ask for it", () => {
    render(
      <PatternView
        props={{ mode: "verify", autoFocus: true }}
        emit={vi.fn()}
      />,
    );
    const wrapper = screen
      .getByRole("application")
      .closest(".moo-secure-frame__focus");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveFocus();
  });

  it("does not take focus by default", () => {
    render(<PatternView props={{ mode: "setup" }} emit={vi.fn()} />);
    expect(document.body).toHaveFocus();
    expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
  });
});
