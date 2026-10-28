import { describe, it, expect, vi, afterEach } from "vitest";
import browser from "webextension-polyfill";
import manifest from "../../../public/manifest.json";
import {
  EXT_ORIGIN,
  HELLO_TYPE,
  MAX_FRAME_HEIGHT,
  acceptHello,
  isFrameHeight,
  isFrameToHostMessage,
  isPropsMessage,
  postToPort,
  sendHello,
  type HelloContext,
  type HelloEvent,
} from "../../../src/secureFrame/protocol";
import { isViewName, isViewProps } from "../../../src/secureFrame/viewProps";

/**
 * Message guards and the handshake check of the Dialog ↔ secure-frame protocol (#363). Every
 * message crossing the port is checked by these guards, so a malformed or hostile payload must be
 * rejected without throwing. Inherited names (`__proto__`, `toString`) are never view names, and a
 * JSON-parsed own `__proto__` key cannot smuggle a field past a guard.
 *
 * `acceptHello` is the frame's only gate on the window-level hello: wrong source, an origin outside
 * the manifest patterns, a bad schema or a nonce mismatch each return null, and a success returns a
 * REBUILT `{ type, nonce, view }` so no extra field of the page-visible message survives.
 */

const PIN_PROPS = { mode: "verify", error: "錯誤", disabled: false };
const SYNC_INPUT_PROPS = {
  value: "moo-abc",
  disabled: false,
  masked: true,
  placeholder: "輸入家庭同步碼",
  ariaLabel: "家庭同步碼",
};
const TEXT_PROPS = { text: "moo-abc", testId: "sync-code" };
const QR_PROPS = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  alt: "QR",
  size: 200,
};

function props(view: string, value: unknown): unknown {
  return { type: "props", view, props: value };
}

describe("isViewName", () => {
  it.each(["pin", "pattern", "sync-code-input", "credential-text", "qr-image"])(
    "accepts %s",
    (view) => {
      expect(isViewName(view)).toBe(true);
    },
  );

  it.each([
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "PIN",
    "",
    1,
    null,
    undefined,
    {},
  ])("rejects %j", (view) => {
    expect(isViewName(view)).toBe(false);
  });
});

describe("isPropsMessage", () => {
  it.each([
    ["pin", PIN_PROPS],
    ["pin", { mode: "setup" }],
    ["pin", { mode: "verify", autoFocus: true }],
    ["pattern", { mode: "setup", disabled: true }],
    ["sync-code-input", SYNC_INPUT_PROPS],
    [
      "sync-code-input",
      { ...SYNC_INPUT_PROPS, className: "x", autoFocus: false },
    ],
    ["credential-text", TEXT_PROPS],
    ["credential-text", { ...TEXT_PROPS, className: "moo-x" }],
    ["qr-image", QR_PROPS],
  ] as const)("accepts a valid %s message", (view, value) => {
    expect(isPropsMessage(props(view, value), view)).toBe(true);
  });

  it("rejects a message addressed to another view", () => {
    expect(isPropsMessage(props("pin", PIN_PROPS), "pattern")).toBe(false);
    expect(isPropsMessage(props("credential-text", TEXT_PROPS), "pin")).toBe(
      false,
    );
  });

  it.each([
    null,
    undefined,
    "props",
    42,
    [],
    { view: "pin", props: PIN_PROPS },
  ])("rejects the non-message %j", (data) => {
    expect(isPropsMessage(data, "pin")).toBe(false);
  });

  it("rejects a wrong message type", () => {
    expect(
      isPropsMessage({ type: "hello", view: "pin", props: PIN_PROPS }, "pin"),
    ).toBe(false);
  });

  it.each([
    ["pin", { mode: "other" }],
    ["pin", {}],
    ["pin", { mode: "verify", error: 1 }],
    ["pin", { mode: "verify", disabled: "true" }],
    ["pin", { mode: "verify", autoFocus: 1 }],
    ["pattern", null],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, value: 1 }],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, masked: undefined }],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, disabled: 0 }],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, placeholder: null }],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, ariaLabel: undefined }],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, className: 1 }],
    ["sync-code-input", { ...SYNC_INPUT_PROPS, autoFocus: "yes" }],
    ["credential-text", { text: 1, testId: "sync-code" }],
    ["credential-text", { text: "x" }],
    ["credential-text", { ...TEXT_PROPS, className: false }],
    ["qr-image", { ...QR_PROPS, dataUrl: "https://evil.com/qr.png" }],
    [
      "qr-image",
      { ...QR_PROPS, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    ],
    ["qr-image", { ...QR_PROPS, dataUrl: "javascript:alert(1)" }],
    ["qr-image", { ...QR_PROPS, alt: undefined }],
    ["qr-image", { ...QR_PROPS, size: 0 }],
    ["qr-image", { ...QR_PROPS, size: -1 }],
    ["qr-image", { ...QR_PROPS, size: Number.NaN }],
    ["qr-image", { ...QR_PROPS, size: Number.POSITIVE_INFINITY }],
    ["qr-image", { ...QR_PROPS, size: "200" }],
  ] as const)("rejects %s props failing the shape check: %j", (view, value) => {
    expect(isPropsMessage(props(view, value), view)).toBe(false);
  });

  it("does not let a JSON own `__proto__` key supply a required field", () => {
    const data: unknown = JSON.parse(
      '{"type":"props","view":"pin","props":{"__proto__":{"mode":"verify"}}}',
    );
    expect(isPropsMessage(data, "pin")).toBe(false);
  });

  it("rejects `__proto__` as a view without throwing", () => {
    const data: unknown = JSON.parse(
      '{"type":"props","view":"__proto__","props":{}}',
    );
    expect(() => isViewName("__proto__")).not.toThrow();
    expect(isViewName("__proto__")).toBe(false);
    expect(isPropsMessage(data, "pin")).toBe(false);
  });

  it("isViewProps agrees with the per-view guard", () => {
    expect(isViewProps("qr-image", QR_PROPS)).toBe(true);
    expect(isViewProps("qr-image", TEXT_PROPS)).toBe(false);
  });
});

describe("isFrameHeight", () => {
  it.each([
    [1, true],
    [120, true],
    [MAX_FRAME_HEIGHT - 1, true],
    [0, false],
    [-5, false],
    [MAX_FRAME_HEIGHT, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ["120", false],
    [null, false],
  ])("%j → %s", (value, expected) => {
    expect(isFrameHeight(value)).toBe(expected);
  });
});

describe("isFrameToHostMessage", () => {
  it.each([
    { type: "ready" },
    { type: "paste" },
    { type: "blur" },
    { type: "height", px: 48 },
    { type: "submit", secret: "123456" },
    { type: "submit", secret: "" },
    { type: "change", value: "moo-abc" },
  ])("accepts %j", (message) => {
    expect(isFrameToHostMessage(message)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "ready",
    [],
    {},
    { type: "props" },
    { type: "__proto__" },
    { type: "toString" },
    { type: "height" },
    { type: "height", px: 0 },
    { type: "height", px: MAX_FRAME_HEIGHT },
    { type: "submit" },
    { type: "submit", secret: 123456 },
    { type: "change" },
    { type: "change", value: null },
  ])("rejects %j", (message) => {
    expect(isFrameToHostMessage(message)).toBe(false);
  });
});

describe("acceptHello", () => {
  const parent = { name: "parent window" };
  const ctx: HelloContext = {
    expectedSource: parent,
    nonce: "0123456789abcdef",
    selfOrigin: "chrome-extension://mock-extension-id",
    manifestMatches: manifest.web_accessible_resources.flatMap(
      (entry) => entry.matches,
    ),
  };
  const hello = { type: HELLO_TYPE, nonce: ctx.nonce, view: "pin" };

  function event(overrides: Partial<HelloEvent> = {}): HelloEvent {
    return {
      source: parent,
      origin: "https://next.readmoo.com",
      data: hello,
      ...overrides,
    };
  }

  it("accepts a hello from the parent on a Readmoo origin and rebuilds it", () => {
    const data = { ...hello, view: "sync-code-input", extra: "dropped" };
    const result = acceptHello(event({ data }), ctx);
    expect(result).toEqual({
      type: HELLO_TYPE,
      nonce: ctx.nonce,
      view: "sync-code-input",
    });
    expect(result).not.toBe(data);
  });

  it("accepts a hello from the extension's own origin (Dialog dev page)", () => {
    expect(acceptHello(event({ origin: ctx.selfOrigin }), ctx)).toEqual(hello);
  });

  it.each([
    ["another window", { source: { name: "other" } }],
    ["a null source", { source: null }],
    ["an origin outside the manifest", { origin: "https://evil.com" }],
    ["a look-alike origin", { origin: "https://next.readmoo.com.evil.com" }],
    ["the opaque origin", { origin: "null" }],
    ["a nonce mismatch", { data: { ...hello, nonce: "ffffffffffffffff" } }],
    ["a missing nonce", { data: { type: HELLO_TYPE, view: "pin" } }],
    ["a numeric nonce", { data: { ...hello, nonce: 1 } }],
    ["a wrong type", { data: { ...hello, type: "hello" } }],
    ["an unknown view", { data: { ...hello, view: "settings" } }],
    ["an inherited view name", { data: { ...hello, view: "__proto__" } }],
    ["a non-object payload", { data: "moo-secure-frame:hello" }],
    ["a null payload", { data: null }],
  ] as const)("returns null for %s", (_label, overrides) => {
    expect(acceptHello(event(overrides), ctx)).toBeNull();
  });

  it("returns null when the source is null even if the context expects null", () => {
    expect(
      acceptHello(event({ source: null }), { ...ctx, expectedSource: null }),
    ).toBeNull();
  });

  it("accepts nothing when the frame's own nonce is empty", () => {
    const empty = { ...ctx, nonce: "" };
    expect(acceptHello(event({ data: { ...hello, nonce: "" } }), empty)).toBe(
      null,
    );
  });
});

describe("sendHello", () => {
  it("posts the hello to the frame with the extension origin and transfers the port", () => {
    const postMessage = vi.fn();
    const target = { postMessage } as unknown as Window;
    const { port2 } = new MessageChannel();
    try {
      sendHello(target, "abc", "pattern", port2);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        { type: HELLO_TYPE, nonce: "abc", view: "pattern" },
        EXT_ORIGIN,
        [port2],
      );
      expect(EXT_ORIGIN).not.toBe("*");
    } finally {
      port2.close();
    }
  });
});

describe("postToPort", () => {
  it("posts the message on the port as is", () => {
    const postMessage = vi.fn();
    const port = { postMessage } as unknown as MessagePort;
    postToPort(port, { type: "submit", secret: "123456" });
    expect(postMessage).toHaveBeenCalledWith({
      type: "submit",
      secret: "123456",
    });
  });
});

describe("EXT_ORIGIN", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("is the extension's scheme + host", () => {
    expect(EXT_ORIGIN).toBe("chrome-extension://mock-extension-id");
  });

  it("serialises a moz-extension origin instead of the opaque 'null'", async () => {
    vi.mocked(browser.runtime.getURL).mockReturnValueOnce(
      "moz-extension://5f0c1d2e-aaaa-bbbb-cccc-0123456789ab/",
    );
    vi.resetModules();
    const fresh = await import("../../../src/secureFrame/protocol");
    expect(fresh.EXT_ORIGIN).toBe(
      "moz-extension://5f0c1d2e-aaaa-bbbb-cccc-0123456789ab",
    );
  });
});
