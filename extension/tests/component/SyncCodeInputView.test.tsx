import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ViewProps } from "@/secureFrame/protocol";
import { SyncCodeInputView } from "@/secureFrame/views/SyncCodeInputView";

/**
 * The secure frame's join-family sync-code field (#363, PLAN 決定 6; seq rule #422). The field owns
 * its text; the Dialog's `value` arrives later over the port. Each typed value goes out as a
 * `change` with a rising `seq`, and the host echoes back `appliedSeq`, the seq of the last change it
 * applied. The view adopts a host value (an invite-link prefill, a clear after the recovery flow)
 * only once `appliedSeq` has caught up with the last seq it sent, and only when the value differs
 * from its own text. So a late echo never eats typing — not even with a repeated value among the
 * in-flight reports (a, ab, a), which a value-compare rule could not tell apart — and a host value
 * sent while the host is behind is not adopted (PLAN 決定 2: a later echo brings the typed text back).
 *
 * `host(...)` plays a props message from the Dialog; each echo carries the `appliedSeq` the host
 * would have reached. Each "not adopted" case is paired with a later value that IS adopted, so the
 * rule cannot pass by never adopting anything.
 */

type Props = ViewProps["sync-code-input"];

const BASE: Props = {
  value: "",
  disabled: false,
  masked: false,
  placeholder: "輸入家庭同步碼",
  ariaLabel: "家庭同步碼",
  appliedSeq: 0,
};

function setup(overrides: Partial<Props> = {}) {
  const emit = vi.fn();
  const view = (props: Partial<Props>) => (
    <SyncCodeInputView
      props={{ ...BASE, ...overrides, ...props }}
      emit={emit}
    />
  );
  const result = render(view({}));
  const host = (props: Partial<Props>) => result.rerender(view(props));
  const input = () => screen.getByLabelText("家庭同步碼") as HTMLInputElement;
  const type = (value: string) =>
    fireEvent.change(input(), { target: { value } });
  return { emit, host, input, type };
}

describe("SyncCodeInputView", () => {
  it("renders the field from its props", () => {
    const { input } = setup({
      value: "moo-abc",
      className: "moo-recovery-join__input",
    });
    expect(input()).toHaveValue("moo-abc");
    expect(input()).toHaveAttribute("type", "text");
    expect(input()).toHaveAttribute("placeholder", "輸入家庭同步碼");
    expect(input()).toHaveAttribute("autocomplete", "off");
    expect(input()).toHaveClass(
      "moo-form-input",
      "moo-form-input--block",
      "moo-recovery-join__input",
    );
    expect(input()).toBeEnabled();
  });

  it("masks the field and disables it on request", () => {
    const { input, host } = setup({ masked: true });
    expect(input()).toHaveAttribute("type", "password");
    host({ masked: false, disabled: true });
    expect(input()).toHaveAttribute("type", "text");
    expect(input()).toBeDisabled();
  });

  it("emits change / paste / blur, each change with the next seq", () => {
    const { emit, input, type } = setup();
    type("moo-a");
    fireEvent.paste(input());
    type("moo-ab");
    fireEvent.blur(input());
    expect(emit.mock.calls).toEqual([
      [{ type: "change", value: "moo-a", seq: 1 }],
      [{ type: "paste" }],
      [{ type: "change", value: "moo-ab", seq: 2 }],
      [{ type: "blur" }],
    ]);
  });

  it("adopts a host prefill and puts the cursor at its end", () => {
    const { input, host } = setup();
    host({ value: "moo-abc123" });
    expect(input()).toHaveValue("moo-abc123");
    expect(input().selectionStart).toBe("moo-abc123".length);
    expect(input().selectionEnd).toBe("moo-abc123".length);
  });

  it("keeps the typed text and the cursor when the host echoes it back", () => {
    const { input, host, type } = setup();
    type("moo-ab");
    input().setSelectionRange(2, 2);
    host({ value: "moo-ab", appliedSeq: 1 });
    expect(input()).toHaveValue("moo-ab");
    expect(input().selectionStart).toBe(2);
  });

  it("adopts a host clear after the typed text was echoed", () => {
    const { input, host, type } = setup();
    type("moo-ab");
    host({ value: "moo-ab", appliedSeq: 1 });
    host({ value: "", appliedSeq: 1 });
    expect(input()).toHaveValue("");
  });

  it("ignores a stale echo of an earlier keystroke, then adopts a real change", () => {
    const { input, host, type } = setup();
    type("a");
    type("ab");

    host({ value: "a", appliedSeq: 1 });
    expect(input()).toHaveValue("ab");

    host({ value: "ab", appliedSeq: 2 });
    expect(input()).toHaveValue("ab");

    // Caught up: the same "a" is now a genuine host change (e.g. a reset) and is adopted.
    host({ value: "a", appliedSeq: 2 });
    expect(input()).toHaveValue("a");
  });

  it("never lets the echo of a repeated value's middle report through (#422: a, ab, a)", () => {
    const { input, host, type } = setup();
    type("a");
    type("ab");
    type("a");

    host({ value: "a", appliedSeq: 1 });
    expect(input()).toHaveValue("a");
    host({ value: "ab", appliedSeq: 2 });
    expect(input()).toHaveValue("a");
    host({ value: "a", appliedSeq: 3 });
    expect(input()).toHaveValue("a");

    // Caught up: a host value is adopted again.
    host({ value: "moo-xyz", appliedSeq: 3 });
    expect(input()).toHaveValue("moo-xyz");
  });

  it("does not adopt a host value while the host is behind, and adopts it once caught up", () => {
    const { input, host, type } = setup();
    type("a");
    type("ab");

    host({ value: "moo-xyz", appliedSeq: 1 });
    expect(input()).toHaveValue("ab");

    // Same value, only the seq moves: catching up alone is enough to adopt it.
    host({ value: "moo-xyz", appliedSeq: 2 });
    expect(input()).toHaveValue("moo-xyz");
  });

  it("adopts a host rewrite of the reported value once caught up, cursor at the end", () => {
    const { input, host, type } = setup();
    type("moo-abc");
    input().setSelectionRange(0, 0);

    host({ value: "moo-ABC", appliedSeq: 1 });

    expect(input()).toHaveValue("moo-ABC");
    expect(input().selectionStart).toBe("moo-ABC".length);
    expect(input().selectionEnd).toBe("moo-ABC".length);
  });

  it("adopts a host value when the host's seq is ahead of the field's (a reloaded frame)", () => {
    const { input, host, type } = setup({ appliedSeq: 4 });
    type("a");
    host({ value: "moo-x", appliedSeq: 4 });
    expect(input()).toHaveValue("moo-x");
  });

  it("focuses the field only when the first props ask for it", () => {
    const first = setup({ autoFocus: true });
    expect(first.input()).toHaveFocus();
  });

  it("does not take focus by default, nor when a later props message asks", () => {
    const { input, host } = setup();
    expect(input()).not.toHaveFocus();
    host({ autoFocus: true });
    expect(input()).not.toHaveFocus();
  });
});
