import { StrictMode, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SecureFrame } from "@/secureFrame/SecureFrame";
import {
  OtpCodeFrame,
  PatternFrame,
  PinFrame,
  QrImageFrame,
  SyncCodeInputFrame,
  SyncCodeTextFrame,
} from "@/secureFrame/frames";
import { EXT_ORIGIN, HELLO_TYPE } from "@/secureFrame/protocol";
import { READY_TIMEOUT_MS } from "@/secureFrame/useSecureFrameChannel";

/**
 * The REAL `SecureFrame` host (#363): `vi.unmock` undoes the jsdom stand-in that
 * `extension/tests/setup.ts` installs for every other suite, for this file and the presets in
 * `frames.tsx` it imports.
 *
 * jsdom never loads `chrome-extension://…/secure-frame.html` (no `load` fires on its own), so each
 * case fires the iframe's `load` itself and stubs that iframe's `contentWindow.postMessage` to catch
 * the hello. `MessageChannel` is replaced by `FakeChannel`, whose ports deliver synchronously and
 * record what was posted and whether they were closed: the frame side of the conversation is
 * played by posting on `port2`, and what the host sent is read from `port1.sent`.
 *
 * Tamper rules: a second `load`, or no `ready` within `READY_TIMEOUT_MS` of mounting (the first
 * `load` may fire unobserved or never — see "drops the frame when `load` never fires"), closes the
 * port and replaces the iframe with 「畫面被干擾，請關閉後重新開啟」. The timeout cases run on
 * vi's fake clock and therefore use no RTL waiter (`.claude/rules/test.md` → Fake timers exclude
 * RTL waiters); `afterEach` swaps the real clock back.
 *
 * Seq echo (#422): `SyncCodeInputFrame` keeps `appliedSeq` and the host its `value`; one `change`
 * sets both in the same port message, so React must answer with ONE props message carrying the new
 * value AND its seq. Split across two renders, one message pairs a value with the wrong seq; "old
 * value, new seq" makes the field adopt the old text and wipe the typing. The test posts the change
 * in a sync `act`, then flushes with an async `act` so a deferred update surfaces as an extra props
 * message.
 */

vi.unmock("../../src/secureFrame/SecureFrame");

const TAMPERED_TEXT = "畫面被干擾，請關閉後重新開啟";

class FakePort {
  other: FakePort | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  readonly sent: unknown[] = [];

  postMessage(data: unknown): void {
    this.sent.push(data);
    if (!this.closed) this.other?.deliver(data);
  }

  deliver(data: unknown): void {
    if (this.closed) return;
    this.onmessage?.({ data } as MessageEvent);
  }

  close(): void {
    this.closed = true;
  }

  start(): void {}
}

class FakeChannel {
  static created: FakeChannel[] = [];
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();

  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
    FakeChannel.created.push(this);
  }
}

function iframe(): HTMLIFrameElement {
  const element = document.querySelector("iframe");
  if (!(element instanceof HTMLIFrameElement)) throw new Error("no iframe");
  return element;
}

/** Spy on the current iframe's window so the hello is captured instead of dispatched. */
function spyHello(frame = iframe()) {
  const target = frame.contentWindow;
  if (!target) throw new Error("iframe has no contentWindow");
  return vi.spyOn(target, "postMessage").mockImplementation(() => {});
}

function fireLoad(frame = iframe()): void {
  act(() => {
    frame.dispatchEvent(new Event("load"));
  });
}

function lastChannel(): FakeChannel {
  const channel = FakeChannel.created.at(-1);
  if (!channel) throw new Error("no MessageChannel created");
  return channel;
}

/** Plays the frame: posts `message` on the frame's end of the port. */
function fromFrame(message: unknown, channel = lastChannel()): void {
  act(() => {
    channel.port2.postMessage(message);
  });
}

function propsMessages(channel = lastChannel()): unknown[] {
  return channel.port1.sent.filter(
    (m) => (m as { type?: unknown }).type === "props",
  );
}

function nonceOf(frame = iframe()): string {
  return new URL(frame.src).hash.replace(/^#n=/, "");
}

describe("SecureFrame", () => {
  beforeEach(() => {
    FakeChannel.created = [];
    vi.stubGlobal("MessageChannel", FakeChannel);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the extension-origin iframe with its title, nonce and placeholder height", () => {
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="PIN 輸入"
        placeholderHeight={120}
        className="extra"
      />,
    );
    const frame = screen.getByTitle("PIN 輸入");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toMatch(
      /^chrome-extension:\/\/mock-extension-id\/secure-frame\.html#n=[0-9a-f]{32}$/,
    );
    expect(frame).toHaveClass("moo-secure-frame", "extra");
    expect(frame.style.height).toBe("120px");
    expect(FakeChannel.created).toHaveLength(0);
  });

  it("gives each frame its own nonce", () => {
    render(
      <>
        <SecureFrame
          view="pin"
          props={{ mode: "verify" }}
          title="a"
          placeholderHeight={1}
        />
        <SecureFrame
          view="pin"
          props={{ mode: "verify" }}
          title="b"
          placeholderHeight={1}
        />
      </>,
    );
    const [a, b] = document.querySelectorAll("iframe");
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });

  it("posts the hello once on the first load: extension origin, nonce, view, transferred port", () => {
    render(
      <SecureFrame
        view="pattern"
        props={{ mode: "setup" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    const hello = spyHello();
    fireLoad();

    expect(FakeChannel.created).toHaveLength(1);
    expect(hello).toHaveBeenCalledTimes(1);
    expect(hello).toHaveBeenCalledWith(
      { type: HELLO_TYPE, nonce: nonceOf(), view: "pattern" },
      EXT_ORIGIN,
      [lastChannel().port2],
    );
    expect(EXT_ORIGIN).toBe("chrome-extension://mock-extension-id");
    // Nothing goes over the port before the frame says it is ready.
    expect(lastChannel().port1.sent).toEqual([]);
  });

  it("sends the props on `ready` without focusing the frame by default", () => {
    const focus = vi.spyOn(HTMLIFrameElement.prototype, "focus");
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify", error: "錯誤" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });

    expect(propsMessages()).toEqual([
      {
        type: "props",
        view: "pin",
        props: { mode: "verify", error: "錯誤", autoFocus: false },
      },
    ]);
    expect(focus).not.toHaveBeenCalled();
  });

  it("focuses the iframe on `ready` when an entry view asks for autoFocus", () => {
    const focus = vi.spyOn(HTMLIFrameElement.prototype, "focus");
    render(
      <SecureFrame
        view="sync-code-input"
        props={{
          value: "",
          disabled: false,
          masked: false,
          placeholder: "p",
          ariaLabel: "a",
          appliedSeq: 0,
        }}
        title="t"
        placeholderHeight={1}
        autoFocus
      />,
    );
    spyHello();
    fireLoad();
    expect(focus).not.toHaveBeenCalled();
    fromFrame({ type: "ready" });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(propsMessages()).toEqual([
      expect.objectContaining({
        view: "sync-code-input",
        props: expect.objectContaining({ autoFocus: true }),
      }),
    ]);
  });

  it("never focuses or sends autoFocus to a display view", () => {
    const focus = vi.spyOn(HTMLIFrameElement.prototype, "focus");
    render(
      <SecureFrame
        view="credential-text"
        props={{ text: "moo-abc", testId: "sync-code" }}
        title="t"
        placeholderHeight={1}
        autoFocus
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });

    expect(focus).not.toHaveBeenCalled();
    expect(propsMessages()).toEqual([
      {
        type: "props",
        view: "credential-text",
        props: { text: "moo-abc", testId: "sync-code" },
      },
    ]);
  });

  it("re-sends the props only when their content changes", () => {
    const { rerender } = render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });
    expect(propsMessages()).toHaveLength(1);

    // Same content, new object identity: nothing new on the port.
    rerender(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    expect(propsMessages()).toHaveLength(1);

    rerender(
      <SecureFrame
        view="pin"
        props={{ mode: "verify", error: "PIN 錯誤" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    expect(propsMessages()).toHaveLength(2);
    expect(propsMessages()[1]).toEqual({
      type: "props",
      view: "pin",
      props: { mode: "verify", error: "PIN 錯誤", autoFocus: false },
    });
  });

  it("does not send props changed before `ready`; `ready` carries the latest", () => {
    const { rerender } = render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    spyHello();
    fireLoad();
    rerender(
      <SecureFrame
        view="pin"
        props={{ mode: "verify", disabled: true }}
        title="t"
        placeholderHeight={1}
      />,
    );
    expect(propsMessages()).toHaveLength(0);

    fromFrame({ type: "ready" });
    expect(propsMessages()).toEqual([
      {
        type: "props",
        view: "pin",
        props: { mode: "verify", disabled: true, autoFocus: false },
      },
    ]);
  });

  it("sizes the iframe from a valid `height` and ignores an invalid one", () => {
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={120}
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });
    fromFrame({ type: "height", px: 77 });
    expect(iframe().style.height).toBe("77px");

    fromFrame({ type: "height", px: 0 });
    fromFrame({ type: "height", px: 4000 });
    fromFrame({ type: "height", px: "90" });
    expect(iframe().style.height).toBe("77px");
  });

  it("routes submit / change / paste / blur to the host callbacks and drops malformed ones", () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const onPaste = vi.fn();
    const onBlur = vi.fn();
    render(
      <SecureFrame
        view="sync-code-input"
        props={{
          value: "",
          disabled: false,
          masked: true,
          placeholder: "p",
          ariaLabel: "a",
          appliedSeq: 0,
        }}
        title="t"
        placeholderHeight={1}
        onSubmit={onSubmit}
        onChange={onChange}
        onPaste={onPaste}
        onBlur={onBlur}
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });

    fromFrame({ type: "submit", secret: "123456" });
    fromFrame({ type: "change", value: "moo-abc", seq: 1 });
    fromFrame({ type: "paste" });
    fromFrame({ type: "blur" });
    fromFrame({ type: "submit", secret: 123456 });
    fromFrame({ type: "change" });
    fromFrame({ type: "unknown" });
    fromFrame(null);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("123456");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("moo-abc", 1);
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("drops a `change` without a valid seq and still routes the next valid one", () => {
    const onChange = vi.fn();
    render(
      <SecureFrame
        view="sync-code-input"
        props={{
          value: "",
          disabled: false,
          masked: false,
          placeholder: "p",
          ariaLabel: "a",
          appliedSeq: 0,
        }}
        title="t"
        placeholderHeight={1}
        onChange={onChange}
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });

    fromFrame({ type: "change", value: "moo-a" });
    fromFrame({ type: "change", value: "moo-a", seq: 0 });
    fromFrame({ type: "change", value: "moo-a", seq: "1" });
    expect(onChange).not.toHaveBeenCalled();

    fromFrame({ type: "change", value: "moo-ab", seq: 2 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("moo-ab", 2);
  });

  it("uses the latest callbacks after a re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
        onSubmit={first}
      />,
    );
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });
    rerender(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
        onSubmit={second}
      />,
    );
    fromFrame({ type: "submit", secret: "654321" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("654321");
  });

  it("drops the frame on a second load: port closed, tamper notice instead of the iframe", () => {
    const onSubmit = vi.fn();
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="PIN 輸入"
        placeholderHeight={1}
        onSubmit={onSubmit}
      />,
    );
    const hello = spyHello();
    const frame = iframe();
    fireLoad(frame);
    fromFrame({ type: "ready" });
    const channel = lastChannel();

    fireLoad(frame);

    expect(channel.port1.closed).toBe(true);
    expect(screen.queryByTitle("PIN 輸入")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(TAMPERED_TEXT);
    expect(screen.getByRole("alert")).toHaveClass("moo-secure-frame__tampered");
    expect(hello).toHaveBeenCalledTimes(1);
    expect(FakeChannel.created).toHaveLength(1);

    // Whatever the reloaded document posts is no longer heard.
    fromFrame({ type: "submit", secret: "123456" }, channel);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drops the frame when no `ready` arrives within the timeout", () => {
    vi.useFakeTimers();
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="PIN 輸入"
        placeholderHeight={1}
      />,
    );
    spyHello();
    fireLoad();
    const channel = lastChannel();

    act(() => {
      vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
    });
    expect(screen.getByTitle("PIN 輸入")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTitle("PIN 輸入")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(TAMPERED_TEXT);
    expect(channel.port1.closed).toBe(true);
    expect(READY_TIMEOUT_MS).toBe(10_000);
  });

  it("drops the frame when `load` never fires and no `ready` arrives within the timeout", () => {
    vi.useFakeTimers();
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="PIN 輸入"
        placeholderHeight={1}
      />,
    );
    // No fireLoad: the load event fired before the listener attached, or never fired at all.
    const hello = spyHello();

    act(() => {
      vi.advanceTimersByTime(READY_TIMEOUT_MS);
    });

    expect(screen.queryByTitle("PIN 輸入")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(TAMPERED_TEXT);
    expect(screen.getByRole("alert")).toHaveClass("moo-secure-frame__tampered");
    expect(hello).not.toHaveBeenCalled();
    expect(FakeChannel.created).toHaveLength(0);
  });

  it("keeps the frame when `ready` arrives in time", () => {
    vi.useFakeTimers();
    render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="PIN 輸入"
        placeholderHeight={1}
      />,
    );
    spyHello();
    fireLoad();
    act(() => {
      vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
    });
    fromFrame({ type: "ready" });
    act(() => {
      vi.advanceTimersByTime(READY_TIMEOUT_MS * 3);
    });

    expect(screen.getByTitle("PIN 輸入")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(lastChannel().port1.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the port and clears the ready timer on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    spyHello();
    fireLoad();
    const channel = lastChannel();
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(channel.port1.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("works under StrictMode: one hello, one channel, props on ready, port closed on unmount", () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <SecureFrame
          view="pin"
          props={{ mode: "verify" }}
          title="PIN 輸入"
          placeholderHeight={1}
          onSubmit={onSubmit}
        />
      </StrictMode>,
    );
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const hello = spyHello();
    fireLoad();

    expect(hello).toHaveBeenCalledTimes(1);
    expect(FakeChannel.created).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fromFrame({ type: "ready" });
    expect(propsMessages()).toHaveLength(1);
    fromFrame({ type: "submit", secret: "123456" });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const channel = lastChannel();
    unmount();
    expect(channel.port1.closed).toBe(true);
  });

  it("mounts a fresh frame with a new nonce when the view changes", () => {
    const { rerender } = render(
      <SecureFrame
        view="pin"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
      />,
    );
    const firstFrame = iframe();
    const firstNonce = nonceOf(firstFrame);
    spyHello(firstFrame);
    fireLoad(firstFrame);
    const firstChannel = lastChannel();

    rerender(
      <SecureFrame
        view="pattern"
        props={{ mode: "verify" }}
        title="t"
        placeholderHeight={1}
      />,
    );

    expect(iframe()).not.toBe(firstFrame);
    expect(nonceOf()).not.toBe(firstNonce);
    expect(firstChannel.port1.closed).toBe(true);

    const hello = spyHello();
    fireLoad();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(hello).toHaveBeenCalledWith(
      expect.objectContaining({ view: "pattern", nonce: nonceOf() }),
      EXT_ORIGIN,
      [lastChannel().port2],
    );
  });
});

describe("secure-frame presets (frames.tsx)", () => {
  it.each([
    [
      "PinFrame",
      <PinFrame key="p" mode="verify" onComplete={() => {}} />,
      "PIN 輸入",
      "120px",
    ],
    [
      "PatternFrame",
      <PatternFrame key="p" mode="setup" onComplete={() => {}} />,
      "圖形驗證",
      "264px",
    ],
    [
      "SyncCodeInputFrame",
      <SyncCodeInputFrame
        key="p"
        value=""
        disabled={false}
        masked={false}
        inputClassName="x"
        onChange={() => {}}
        onPaste={() => {}}
        onBlur={() => {}}
      />,
      "家庭同步碼",
      "48px",
    ],
    [
      "SyncCodeTextFrame",
      <SyncCodeTextFrame key="p" syncCode="moo-abc" textClassName="x" />,
      "家庭同步碼",
      "32px",
    ],
    ["OtpCodeFrame", <OtpCodeFrame key="p" code="123456" />, "驗證碼", "32px"],
    [
      "QrImageFrame",
      <QrImageFrame
        key="p"
        dataUrl="data:image/png;base64,AAAA"
        alt="QR"
        size={180}
      />,
      "QR Code",
      "180px",
    ],
  ])(
    "%s renders a titled iframe at its placeholder height",
    (_name, element, title, height) => {
      render(element);
      const frame = screen.getByTitle(title);
      expect(frame.tagName).toBe("IFRAME");
      expect(frame.style.height).toBe(height);
      expect(frame.getAttribute("src")).toContain("secure-frame.html#n=");
    },
  );

  it("SyncCodeInputFrame bleeds the frame past its box for the focus ring", () => {
    render(
      <SyncCodeInputFrame
        value=""
        disabled={false}
        masked
        inputClassName="x"
        onChange={() => {}}
        onPaste={() => {}}
        onBlur={() => {}}
      />,
    );
    expect(screen.getByTitle("家庭同步碼")).toHaveClass(
      "moo-secure-frame",
      "moo-secure-frame--bleed",
    );
  });
});

/** A controlled host: holds the field's value in state and feeds it back, as the Onboarding views do. */
function ControlledSyncCodeInput() {
  const [value, setValue] = useState("");
  return (
    <SyncCodeInputFrame
      value={value}
      disabled={false}
      masked={false}
      inputClassName="x"
      onChange={setValue}
      onPaste={() => {}}
      onBlur={() => {}}
    />
  );
}

describe("SyncCodeInputFrame seq echo (#422)", () => {
  beforeEach(() => {
    FakeChannel.created = [];
    vi.stubGlobal("MessageChannel", FakeChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts the props at appliedSeq 0", () => {
    render(<ControlledSyncCodeInput />);
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });

    expect(propsMessages()).toEqual([
      {
        type: "props",
        view: "sync-code-input",
        props: expect.objectContaining({ value: "", appliedSeq: 0 }),
      },
    ]);
  });

  it("answers a change with exactly one props message carrying both the new value and its seq", async () => {
    render(<ControlledSyncCodeInput />);
    spyHello();
    fireLoad();
    fromFrame({ type: "ready" });
    expect(propsMessages()).toHaveLength(1);

    fromFrame({ type: "change", value: "moo-a", seq: 1 });
    // Flush anything deferred past the port message (a microtask, a late render).
    await act(async () => {});

    expect(propsMessages()).toHaveLength(2);
    expect(propsMessages()[1]).toEqual({
      type: "props",
      view: "sync-code-input",
      props: expect.objectContaining({ value: "moo-a", appliedSeq: 1 }),
    });
  });
});
