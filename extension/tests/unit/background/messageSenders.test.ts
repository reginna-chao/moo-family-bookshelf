import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { messageHandlers } from "@/background/messageHandlers";

/**
 * Guard: every background message handler has a sender (#366).
 *
 * Four handlers (two getters and the toolbar sync-error badge pair) once sat in
 * `messageHandlers` with nothing in the Extension ever sending them — dead
 * code that still had to be reviewed, tested and kept safe, and that looked
 * like a live contract to the next reader. This file reads every `.ts` / `.tsx` under `extension/src/` off disk,
 * skips `background/` (the handlers' own home, which would match itself), and
 * fails for any `messageHandlers` key that no remaining file sends as
 * `type: "<KEY>"`. Adding a handler without a sender, or deleting the last
 * sender of a handler, turns CI red; the fix is to remove the handler too.
 *
 * The match is textual (`type: "<KEY>"`, the shape Prettier gives every
 * `sendMessage({ type: … })` literal), so a sender that builds the type from a
 * variable would not be found — keep message types as string literals.
 *
 * No `@vitest-environment node`: importing the real `messageHandlers` pulls in
 * `webextension-polyfill`, which needs the browser mock from `tests/setup.ts`.
 * Paths from `readdirSync(…, { recursive: true })` use `\` on Windows, so they
 * are normalised before the `background/` prefix check.
 */

const SRC_ROOT = resolve(__dirname, "../../../src");

function senderSources(): { path: string; content: string }[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .map((relative) => relative.replace(/\\/g, "/"))
    .filter((relative) => /\.tsx?$/.test(relative))
    .filter((relative) => !relative.startsWith("background/"))
    .map((relative) => ({
      path: relative,
      content: readFileSync(resolve(SRC_ROOT, relative), "utf8"),
    }));
}

const HANDLER_TYPES = Object.keys(messageHandlers);
const SOURCES = senderSources();

describe("messageHandlers", () => {
  it("scans a non-empty handler map against a non-empty source tree", () => {
    // Either list empty would make every per-type case below pass vacuously.
    expect(HANDLER_TYPES.length).toBeGreaterThan(0);
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.some((s) => s.path.startsWith("dialog/"))).toBe(true);
  });

  it.each(HANDLER_TYPES)(
    "has at least one sender of %s outside background/",
    (type) => {
      const pattern = new RegExp(`type: "${type}"`);
      const senders = SOURCES.filter((s) => pattern.test(s.content)).map(
        (s) => s.path,
      );

      expect(senders, `no file under src/ sends ${type}`).not.toEqual([]);
    },
  );
});
