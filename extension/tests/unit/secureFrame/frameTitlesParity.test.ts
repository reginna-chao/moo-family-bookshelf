import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  OtpCodeFrame,
  PatternFrame,
  PinFrame,
  QrImageFrame,
  SyncCodeInputFrame,
  SyncCodeTextFrame,
} from "../../../src/secureFrame/frames";

/**
 * `SECURE_FRAME_TITLES` in `tests/e2e/helpers/dialog-helper.ts` copies the frame titles of the
 * presets in `src/secureFrame/frames.tsx`: the helper runs under plain Node, where `frames.tsx`
 * cannot load. A rename on one side would only fail the E2E specs at runtime, so this pins the two
 * sets equal at `pnpm test` time. The helper is read as text (it imports `@playwright/test`).
 *
 * Each preset is RENDERED (`SyncCodeInputFrame` holds a `useState`, so it cannot be called as a
 * plain function). This file's own `vi.mock` overrides the `tests/setup.ts` stand-in, which renders
 * the view inline and drops the title, with a `SecureFrame` that renders only `<iframe title>`; the
 * titles are read back from the DOM. The file stays `.ts` (`createElement`, no JSX): the vitest
 * `include` collects only `.test.ts` files under `tests/unit/`, so a `.tsx` rename would silently
 * drop it.
 */

vi.mock("../../../src/secureFrame/SecureFrame", async () => {
  const react = await import("react");
  return {
    SecureFrame: ({ title }: { title: string }) =>
      react.createElement("iframe", { title }),
  };
});

const noop = () => {};
const HELPER = resolve(__dirname, "../../e2e/helpers/dialog-helper.ts");

function helperTitles(source: string): Set<string> {
  const block = /SECURE_FRAME_TITLES = \{([\s\S]*?)\} as const/.exec(source);
  if (!block) throw new Error("SECURE_FRAME_TITLES not found");
  return new Set([...block[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]));
}

function presetTitles(): Set<string> {
  const { container, unmount } = render(
    createElement(
      "div",
      null,
      createElement(PinFrame, { mode: "verify", onComplete: noop }),
      createElement(PatternFrame, { mode: "verify", onComplete: noop }),
      createElement(SyncCodeInputFrame, {
        ...{ value: "", disabled: false, masked: false, inputClassName: "" },
        ...{ onChange: noop, onPaste: noop, onBlur: noop },
      }),
      createElement(SyncCodeTextFrame, {
        syncCode: "moo-abc",
        textClassName: "",
      }),
      createElement(OtpCodeFrame, { code: "123456" }),
      createElement(QrImageFrame, {
        dataUrl: "data:image/png;base64,AA==",
        alt: "",
        size: 1,
      }),
    ),
  );
  const frames = [...container.querySelectorAll("iframe")];
  unmount();
  // One iframe per preset, or a preset silently rendering nothing would drop out of the set.
  expect(frames).toHaveLength(6);
  return new Set(frames.map((frame) => frame.title));
}

describe("secure-frame title parity (frames.tsx ↔ e2e dialog-helper)", () => {
  it("SECURE_FRAME_TITLES holds exactly the presets' titles", () => {
    const helper = helperTitles(readFileSync(HELPER, "utf-8"));
    expect(helper.size).toBeGreaterThan(0);
    expect(helper).toEqual(presetTitles());
  });

  it("detects a renamed title (self-check of the parser)", () => {
    const renamed = readFileSync(HELPER, "utf-8").replace(
      '"PIN 輸入"',
      '"PIN"',
    );
    expect(helperTitles(renamed)).not.toEqual(presetTitles());
  });
});
