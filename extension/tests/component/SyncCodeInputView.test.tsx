import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ViewProps } from "@/secureFrame/protocol";
import { SyncCodeInputView } from "@/secureFrame/views/SyncCodeInputView";

/**
 * The secure frame's join-family sync-code field (#363, PLAN 決定 6). The field owns its text; the
 * Dialog's `value` arrives later over the port, so the view adopts a host value (an invite-link
 * prefill, a clear after the recovery flow) only when it is new — never its own last report, and
 * not an older report still waiting for its echo. Otherwise a late echo of "a" would wipe the "ab"
 * the user has meanwhile typed. Known gap (#422, accepted residual): the rule compares VALUES, so a
 * repeated value among three or more in-flight reports (a, ab, a) can still let the "ab" echo
 * through. Each "not adopted" case is paired with a later value that IS adopted, so the rule cannot
 * pass by never adopting anything.
 */

type Props = ViewProps["sync-code-input"];

const BASE: Props = {
  value: "",
  disabled: false,
  masked: false,
  placeholder: "輸入家庭同步碼",
  ariaLabel: "家庭同步碼",
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

  it("emits change / paste / blur", () => {
    const { emit, input, type } = setup();
    type("moo-a");
    fireEvent.paste(input());
    fireEvent.blur(input());
    expect(emit.mock.calls).toEqual([
      [{ type: "change", value: "moo-a" }],
      [{ type: "paste" }],
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

  it("keeps the typed text when the host echoes it back", () => {
    const { input, host, type } = setup();
    type("moo-ab");
    host({ value: "moo-ab" });
    expect(input()).toHaveValue("moo-ab");
  });

  it("adopts a host clear after the typed text was echoed", () => {
    const { input, host, type } = setup();
    type("moo-ab");
    host({ value: "moo-ab" });
    host({ value: "" });
    expect(input()).toHaveValue("");
  });

  it("ignores a stale echo of an earlier keystroke, then adopts a real change", () => {
    const { input, host, type } = setup();
    type("a");
    type("ab");

    host({ value: "a" });
    expect(input()).toHaveValue("ab");

    host({ value: "ab" });
    expect(input()).toHaveValue("ab");

    // Caught up: the same "a" is now a genuine host change (e.g. a reset) and is adopted.
    host({ value: "a" });
    expect(input()).toHaveValue("a");
  });

  it("adopts a host value it never reported, even while echoes are pending", () => {
    const { input, host, type } = setup();
    type("a");
    type("ab");
    host({ value: "moo-xyz" });
    expect(input()).toHaveValue("moo-xyz");
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
