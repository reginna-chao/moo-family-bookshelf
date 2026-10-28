import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FrameApp } from "@/secureFrame/FrameApp";
import type { ViewName } from "@/secureFrame/protocol";
import { drawPattern, patternConfirmButton } from "./helpers/patternGrid";

/**
 * The secure frame's root (#363), driven over a REAL `MessageChannel` (Node's own; jsdom has none):
 * `port1` is handed to `FrameApp` the way `main.tsx` does after the hello, and the test plays the
 * Dialog on `port2`. Node delivers port messages asynchronously, so arrivals are awaited with
 * `waitFor`; no fake clock is used in this file.
 *
 * "Ignored" cases need a barrier: a second listener on `port1` (`frameInbox`) sees each message in
 * the same dispatch as `FrameApp`'s own, so once it has seen the bad message, `FrameApp` has too;
 * an `act` flush later the frame must still render nothing. Each such case is paired with a valid
 * message that does render, so a broken port cannot pass it vacuously.
 *
 * jsdom lacks `ResizeObserver`; a stub records `observe` / `disconnect` and, when `fireOnObserve`
 * is set, calls its callback once with a stubbed document height.
 */

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  static fireOnObserve = false;
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
    if (StubResizeObserver.fireOnObserve) {
      this.callback([], this as unknown as ResizeObserver);
    }
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }
}

const PIN_LABEL = "PIN 碼輸入";

let channel: MessageChannel;
let hostInbox: unknown[];
let frameInbox: unknown[];

function mountFrame(view: ViewName) {
  const result = render(<FrameApp view={view} port={channel.port1} />);
  channel.port1.addEventListener("message", (event) => {
    frameInbox.push(event.data);
  });
  return result;
}

function sendProps(view: string, props: unknown): void {
  channel.port2.postMessage({ type: "props", view, props });
}

async function waitForReady(): Promise<void> {
  await waitFor(() => expect(hostInbox).toContainEqual({ type: "ready" }));
}

/** Waits until the frame has been handed `count` messages, then flushes React. */
async function frameHasSeen(count: number): Promise<void> {
  await waitFor(() => expect(frameInbox).toHaveLength(count));
  await act(async () => {});
}

describe("FrameApp", () => {
  beforeEach(() => {
    channel = new MessageChannel();
    hostInbox = [];
    frameInbox = [];
    channel.port2.onmessage = (event) => {
      hostInbox.push(event.data);
    };
    StubResizeObserver.instances = [];
    StubResizeObserver.fireOnObserve = false;
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
  });

  afterEach(() => {
    channel.port1.close();
    channel.port2.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends `ready` once mounted and renders nothing before the first props", async () => {
    const { container } = mountFrame("pin");
    await waitForReady();
    expect(hostInbox).toEqual([{ type: "ready" }]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the requested view from a matching props message", async () => {
    mountFrame("pin");
    await waitForReady();
    sendProps("pin", { mode: "verify", error: "PIN 錯誤" });

    expect(await screen.findByLabelText(PIN_LABEL)).toBeInTheDocument();
    expect(screen.getByText("PIN 錯誤")).toBeInTheDocument();
  });

  it("re-renders with each later props message", async () => {
    mountFrame("pin");
    await waitForReady();
    sendProps("pin", { mode: "verify" });
    expect(await screen.findByText("請輸入 PIN 碼")).toBeInTheDocument();

    sendProps("pin", { mode: "setup" });
    expect(await screen.findByText("設定 PIN 碼")).toBeInTheDocument();
  });

  it("ignores props addressed to another view or failing the shape check", async () => {
    const { container } = mountFrame("pin");
    await waitForReady();
    sendProps("pattern", { mode: "verify" });
    sendProps("pin", { mode: "admin" });
    sendProps("credential-text", { text: "moo-abc", testId: "sync-code" });
    channel.port2.postMessage({ type: "ready" });
    channel.port2.postMessage("props");
    await frameHasSeen(5);

    expect(container).toBeEmptyDOMElement();

    // Positive companion: the same port does render a valid message.
    sendProps("pin", { mode: "verify" });
    expect(await screen.findByLabelText(PIN_LABEL)).toBeInTheDocument();
  });

  it("keeps the current view when a later message is invalid", async () => {
    mountFrame("pin");
    await waitForReady();
    sendProps("pin", { mode: "verify", error: "第一次" });
    expect(await screen.findByText("第一次")).toBeInTheDocument();

    sendProps("pin", { mode: "verify", error: 42 });
    await frameHasSeen(2);
    expect(screen.getByText("第一次")).toBeInTheDocument();
  });

  it("posts `submit` with the PIN typed into the real PinInput", async () => {
    mountFrame("pin");
    await waitForReady();
    sendProps("pin", { mode: "verify" });
    const input = await screen.findByLabelText(PIN_LABEL);

    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "確認" }));

    await waitFor(() =>
      expect(hostInbox).toContainEqual({ type: "submit", secret: "123456" }),
    );
  });

  it("posts `submit` with the pattern drawn on the real PatternLock", async () => {
    mountFrame("pattern");
    await waitForReady();
    sendProps("pattern", { mode: "verify" });
    await screen.findByRole("application");

    drawPattern([0, 1, 2, 5]);
    fireEvent.click(patternConfirmButton());

    await waitFor(() =>
      expect(hostInbox).toContainEqual({ type: "submit", secret: "0,1,2,5" }),
    );
  });

  it("posts change / paste / blur from the sync-code field", async () => {
    mountFrame("sync-code-input");
    await waitForReady();
    sendProps("sync-code-input", {
      value: "",
      disabled: false,
      masked: false,
      placeholder: "輸入家庭同步碼",
      ariaLabel: "家庭同步碼",
    });
    const input = await screen.findByRole("textbox", { name: "家庭同步碼" });

    fireEvent.change(input, { target: { value: "moo-abc" } });
    fireEvent.paste(input);
    fireEvent.blur(input);

    await waitFor(() =>
      expect(hostInbox).toEqual([
        { type: "ready" },
        { type: "change", value: "moo-abc" },
        { type: "paste" },
        { type: "blur" },
      ]),
    );
  });

  it("renders a credential text with the caller's test id and class", async () => {
    mountFrame("credential-text");
    await waitForReady();
    sendProps("credential-text", {
      text: "moo-abc123",
      testId: "sync-code",
      className: "moo-settings__sync-code-text",
    });

    const text = await screen.findByTestId("sync-code");
    expect(text).toHaveTextContent("moo-abc123");
    expect(text).toHaveClass("moo-settings__sync-code-text");
  });

  it("renders a QR image that cannot be dragged", async () => {
    mountFrame("qr-image");
    await waitForReady();
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    sendProps("qr-image", { dataUrl, alt: "掃描此 QR Code", size: 180 });

    const img = await screen.findByAltText("掃描此 QR Code");
    expect(img).toHaveAttribute("src", dataUrl);
    expect(img).toHaveAttribute("width", "180");
    expect(img).toHaveAttribute("height", "180");
    expect(img).toHaveAttribute("draggable", "false");
  });

  it("reports the document height (rounded up) through the ResizeObserver", async () => {
    StubResizeObserver.fireOnObserve = true;
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue(
      { height: 123.2 } as DOMRect,
    );
    mountFrame("pin");

    await waitFor(() =>
      expect(hostInbox).toEqual([
        { type: "ready" },
        { type: "height", px: 124 },
      ]),
    );
    expect(StubResizeObserver.instances).toHaveLength(1);
    expect(StubResizeObserver.instances[0].observed).toEqual([
      document.documentElement,
    ]);
  });

  it("reports no height while the document has none", async () => {
    StubResizeObserver.fireOnObserve = true;
    mountFrame("pin");
    await waitForReady();
    sendProps("pin", { mode: "verify" });
    const input = await screen.findByLabelText(PIN_LABEL);
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "確認" }));

    // The submit arriving after the observer fired orders the check.
    await waitFor(() =>
      expect(hostInbox).toContainEqual({ type: "submit", secret: "123456" }),
    );
    expect(hostInbox).not.toContainEqual(
      expect.objectContaining({ type: "height" }),
    );
  });

  it("disconnects the observer and stops listening on unmount", async () => {
    const { unmount } = mountFrame("pin");
    await waitForReady();
    unmount();

    expect(StubResizeObserver.instances.at(-1)?.disconnected).toBe(true);
    sendProps("pin", { mode: "verify" });
    await frameHasSeen(1);
    expect(screen.queryByLabelText(PIN_LABEL)).not.toBeInTheDocument();
  });
});
