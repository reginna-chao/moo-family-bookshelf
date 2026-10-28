import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";
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
 * sets equal at `pnpm test` time. The helper is read as text (it imports `@playwright/test`); each
 * preset is called as a plain function (they hold no hooks) and its `<SecureFrame title>` is read.
 */

const noop = () => {};
const HELPER = resolve(__dirname, "../../e2e/helpers/dialog-helper.ts");

function helperTitles(source: string): Set<string> {
  const block = /SECURE_FRAME_TITLES = \{([\s\S]*?)\} as const/.exec(source);
  if (!block) throw new Error("SECURE_FRAME_TITLES not found");
  return new Set([...block[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]));
}

function presetTitles(): Set<string> {
  const elements = [
    PinFrame({ mode: "verify", onComplete: noop }),
    PatternFrame({ mode: "verify", onComplete: noop }),
    SyncCodeInputFrame({
      ...{ value: "", disabled: false, masked: false, inputClassName: "" },
      ...{ onChange: noop, onPaste: noop, onBlur: noop },
    }),
    SyncCodeTextFrame({ syncCode: "moo-abc", textClassName: "" }),
    OtpCodeFrame({ code: "123456" }),
    QrImageFrame({ dataUrl: "data:image/png;base64,AA==", alt: "", size: 1 }),
  ];
  return new Set(elements.map((el) => (el.props as { title: string }).title));
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
