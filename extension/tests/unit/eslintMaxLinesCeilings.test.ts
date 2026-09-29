// @vitest-environment node
/**
 * The `max-lines` legacy ratchet in `extension/eslint.config.js` and
 * `shared/eslint.config.js` (issue #210).
 *
 * WHAT ESLINT ALREADY GUARANTEES, AND WHAT IT DOES NOT. Every `src/` file is
 * capped at 200 raw lines; the files that were already longer are pinned by
 * `MAX_LINES_LEGACY_CEILINGS` to their line count at that time, so `pnpm lint`
 * turns red the moment one GROWS. Nothing in ESLint notices the opposite
 * drift: a listed file that shrinks keeps its old, now-loose ceiling (room to
 * grow back without anyone deciding so), a file that is deleted or renamed
 * leaves a dead entry, and a file that shrinks to 200 or fewer keeps an
 * exemption it no longer needs. The documented maintenance rule — lower the
 * number in the same change, delete the entry at ≤ 200, never raise or add —
 * is enforced HERE: every entry must name an existing file whose line count
 * EQUALS its ceiling, and every ceiling must be above the base cap.
 *
 * WHERE THE ALLOWLIST COMES FROM. The config module itself is imported and
 * its flat-config array is walked, so the test sees exactly the blocks ESLint
 * sees rather than re-parsing source text. Every block that sets `max-lines`
 * is classified: the one glob block is the base cap, a single-path block is a
 * legacy ceiling, and anything else (an `"off"`, a multi-file block, a skip
 * option) fails the "only two shapes" case — so an exemption cannot be
 * smuggled in outside the table either. `calculateConfigForFile` then confirms
 * each ceiling is the cap ESLint actually applies to that file.
 *
 * HOW LINES ARE COUNTED. `countLinesLikeEslint` mirrors ESLint's `max-lines`
 * with no skip options: split on every line break ESLint recognises, and do
 * not count the empty "line" after a trailing newline (`wc -l` semantics). The
 * "agrees with ESLint" cases pin that against ESLint's own `Linter` — the
 * count passes at `max: n` and is reported at `max: n - 1` — on synthetic
 * inputs and on one real legacy file per package.
 *
 * WHY THIS FILE LIVES HERE. `.github/workflows/cicd.yml` runs extension-check
 * for the `extension` path filter, which covers `extension/**` AND
 * `shared/**`; a change to `shared/eslint.config.js` or a `shared/src/` file
 * alone therefore runs this suite. The PWA's config is checked by its twin,
 * `pwa/tests/unit/eslintMaxLinesCeilings.test.ts`, because pwa-check is the
 * only job the `pwa` filter triggers. Each copy validates its own counter
 * against ESLint, so the two need no parity check of their own.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";

// Resolve from `import.meta.url` as a STRING — Vite rewrites the literal
// `new URL("...", import.meta.url)` form into a served asset URL.
const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = resolve(HERE, "../..");
const SHARED_ROOT = resolve(EXTENSION_ROOT, "../shared");

/** Must match `MAX_LINES` in each package's `eslint.config.js`. */
const BASE_MAX_LINES = 200;
const BASE_FILES_GLOB = "src/**/*.{ts,tsx}";
const GLOB_CHARS = /[*?{}[\]!]/u;

// Built from code points so no invisible character sits in this source.
const BOM = String.fromCharCode(0xfeff);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
// ESLint's `lineBreakPattern` (lib/shared/ast-utils.js).
const LINE_BREAK = new RegExp(
  `\r\n|[\r\n${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`,
  "u",
);

/** Line count as ESLint `max-lines` measures it without skip options. */
function countLinesLikeEslint(text: string): number {
  const withoutBom = text.startsWith(BOM) ? text.slice(1) : text;
  const lines = withoutBom.split(LINE_BREAK);
  // ESLint drops the empty "line" after a trailing line break.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length;
}

interface MaxLinesBlock {
  files: readonly unknown[];
  setting: unknown;
}

interface LegacyCeiling {
  file: string;
  max: number;
}

/**
 * The cap a `max-lines` setting enforces, or `null` when the setting is not
 * the plain `["error", { max }]` shape — a skip option, `"off"`, or a bare
 * severity all return `null`, because they would make the line counts below
 * meaningless.
 */
function plainMax(setting: unknown): number | null {
  if (!Array.isArray(setting) || setting.length !== 2) return null;
  const [severity, options] = setting as [unknown, unknown];
  if (severity !== "error" && severity !== 2) return null;
  if (typeof options !== "object" || options === null) return null;
  const { max, ...rest } = options as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  return typeof max === "number" && Number.isInteger(max) ? max : null;
}

async function loadMaxLinesBlocks(pkgRoot: string): Promise<MaxLinesBlock[]> {
  const configUrl = pathToFileURL(join(pkgRoot, "eslint.config.js")).href;
  const mod = (await import(/* @vite-ignore */ configUrl)) as {
    default?: unknown;
  };
  if (!Array.isArray(mod.default)) {
    throw new Error(`${configUrl} does not default-export a flat config array`);
  }
  const blocks: MaxLinesBlock[] = [];
  for (const block of mod.default as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const { files, rules } = block as { files?: unknown; rules?: unknown };
    if (typeof rules !== "object" || rules === null) continue;
    if (!Object.hasOwn(rules, "max-lines")) continue;
    blocks.push({
      files: Array.isArray(files) ? (files as unknown[]) : [],
      setting: (rules as Record<string, unknown>)["max-lines"],
    });
  }
  if (blocks.length === 0) {
    throw new Error(
      `${configUrl} sets max-lines nowhere — the ratchet is gone`,
    );
  }
  return blocks;
}

function isBaseBlock(block: MaxLinesBlock): boolean {
  return block.files.some((f) => typeof f === "string" && GLOB_CHARS.test(f));
}

function isCeilingBlock(block: MaxLinesBlock): boolean {
  const [file] = block.files;
  return (
    block.files.length === 1 &&
    typeof file === "string" &&
    !GLOB_CHARS.test(file) &&
    plainMax(block.setting) !== null
  );
}

function toCeilings(blocks: readonly MaxLinesBlock[]): LegacyCeiling[] {
  return blocks.filter(isCeilingBlock).map((block) => ({
    file: block.files[0] as string,
    max: plainMax(block.setting) as number,
  }));
}

/**
 * Flat config that runs `max-lines` alone through the TS parser. No type
 * information is needed, but `tsconfigRootDir` must still be explicit: once
 * two packages' configs are loaded, typescript-eslint sees two candidate roots
 * and refuses to guess.
 */
function maxLinesOnly(max: number): Linter.Config[] {
  return [
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: {
        parser: tseslint.parser as Linter.Parser,
        parserOptions: { tsconfigRootDir: EXTENSION_ROOT },
      },
      rules: { "max-lines": ["error", { max }] },
    },
  ];
}

/** Asserts ESLint accepts `text` at `max: n` and reports it at `n - 1`. */
function expectEslintCounts(text: string, filename: string, n: number): void {
  const linter = new Linter({ configType: "flat" });
  const atCap = linter.verify(text, maxLinesOnly(n), { filename });
  expect(atCap, `${filename} should pass max-lines at ${n}`).toEqual([]);
  const overCap = linter.verify(text, maxLinesOnly(n - 1), { filename });
  expect(overCap.map((m) => m.ruleId)).toEqual(["max-lines"]);
}

const PACKAGES = [
  {
    label: "extension/eslint.config.js",
    root: EXTENSION_ROOT,
    blocks: await loadMaxLinesBlocks(EXTENSION_ROOT),
    anchor: "src/api/client.ts",
    uncapped: "src/dialog/useOnboardingFlow.ts",
  },
  {
    label: "shared/eslint.config.js",
    root: SHARED_ROOT,
    blocks: await loadMaxLinesBlocks(SHARED_ROOT),
    anchor: "src/config/readmoo.ts",
    uncapped: "src/crypto/hash.ts",
  },
] as const;

describe("countLinesLikeEslint", () => {
  it.each([
    { name: "no trailing newline", text: "a;\nb;", lines: 2 },
    { name: "trailing LF is not a line", text: "a;\nb;\n", lines: 2 },
    { name: "CRLF line breaks", text: "a;\r\nb;\r\n", lines: 2 },
    { name: "a trailing blank line counts", text: "a;\nb;\n\n", lines: 3 },
    {
      name: "blank and comment lines count",
      text: "// c\n\na;\n/* d */\n",
      lines: 4,
    },
    { name: "a BOM is not content", text: `${BOM}a;\n`, lines: 1 },
  ])("agrees with ESLint max-lines: $name", ({ text, lines }) => {
    expect(countLinesLikeEslint(text)).toBe(lines);
    expectEslintCounts(text, "fixture.ts", lines);
  });
});

describe.each(PACKAGES)("$label max-lines ratchet", (pkg) => {
  const ceilings = toCeilings(pkg.blocks);

  it("caps src/ at 200 lines through exactly one glob block", () => {
    const base = pkg.blocks.filter(isBaseBlock);
    expect(base).toHaveLength(1);
    expect(base[0].files).toEqual([BASE_FILES_GLOB]);
    expect(plainMax(base[0].setting)).toBe(BASE_MAX_LINES);
  });

  it("sets max-lines only through the base block or single-file ceilings, one per file", () => {
    const unrecognised = pkg.blocks.filter(
      (block) => !isBaseBlock(block) && !isCeilingBlock(block),
    );
    expect(unrecognised).toEqual([]);
    const files = ceilings.map((c) => c.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it(`lists at least one legacy ceiling, including ${pkg.anchor}`, () => {
    expect(ceilings.length).toBeGreaterThan(0);
    expect(ceilings.map((c) => c.file)).toContain(pkg.anchor);
  });

  it(`counts ${pkg.anchor} exactly as ESLint does`, () => {
    const text = readFileSync(join(pkg.root, pkg.anchor), "utf8");
    expectEslintCounts(text, pkg.anchor, countLinesLikeEslint(text));
  });

  it.each(ceilings)(
    "$file: exists, is over 200 lines, and its ceiling ($max) equals its line count",
    ({ file, max }) => {
      const path = join(pkg.root, file);
      expect(
        existsSync(path),
        `${file} no longer exists — delete its entry`,
      ).toBe(true);
      const lines = countLinesLikeEslint(readFileSync(path, "utf8"));
      expect(
        lines,
        `${file} is ${lines} lines — set its ceiling to ${lines}, or delete the entry at ≤ ${BASE_MAX_LINES}`,
      ).toBe(max);
      expect(
        max,
        `${file} fits the base cap — delete its entry`,
      ).toBeGreaterThan(BASE_MAX_LINES);
    },
  );

  it("is the cap ESLint applies to each listed file, and 200 to an unlisted one", async () => {
    const eslint = new ESLint({ cwd: pkg.root });
    const effectiveMax = async (file: string): Promise<number | null> => {
      const config = (await eslint.calculateConfigForFile(
        join(pkg.root, file),
      )) as { rules?: Record<string, unknown> } | undefined;
      const setting = config?.rules?.["max-lines"];
      if (!Array.isArray(setting)) return null;
      const options = setting[1] as { max?: unknown } | undefined;
      return typeof options?.max === "number" ? options.max : null;
    };

    for (const { file, max } of ceilings) {
      expect(await effectiveMax(file), file).toBe(max);
    }
    expect(ceilings.map((c) => c.file)).not.toContain(pkg.uncapped);
    expect(await effectiveMax(pkg.uncapped), pkg.uncapped).toBe(BASE_MAX_LINES);
  });
});
