/**
 * Declared Node floor vs. the floor the toolchain DEMANDS (tripwire).
 *
 * WHY. The root `package.json` -> `engines.node` is the only place this repo
 * tells a contributor or a self-hoster which Node version it runs on, and
 * NOTHING ties that number to what the toolchain actually needs. CI pins
 * `node-version: 22`, so lint / typecheck / test / build stay green whatever
 * the declared floor says; the drift surfaces only on someone else's machine.
 * It has already happened once: a lockfile bump moved wrangler to 4.132.0,
 * whose own `engines.node` is `>=22.0.0` and whose `bin/wrangler.js`
 * hard-exits below Node 22, while the root `package.json` still declared
 * `>=20` -- so every wrangler command (`pnpm dev`, `pnpm build`,
 * `wrangler deploy`) died instantly for anyone who took the declared floor at
 * its word, and no check in the repo went red.
 *
 * WHAT IT PINS. Exactly one property: the floor the repo DECLARES must satisfy
 * the floor wrangler DEMANDS. Both are read off disk -- the declaration from
 * the root `package.json`, the demand from the INSTALLED
 * `worker/node_modules/wrangler/package.json` (resolved relative to this file,
 * never via `process.cwd()`), so a dependency bump that raises wrangler's
 * requirement fails here instead of in a self-hoster's terminal.
 *
 * NO `semver` DEPENDENCY. `semver` is not a direct dependency of `worker/`, and
 * a transitive package can vanish on the next bump. Both strings are simple
 * `>=X[.Y[.Z]]` ranges today, so `parseMinimumVersion()` handles exactly that
 * shape and THROWS on anything else (a caret, an `||`, a bare version) rather
 * than quietly passing an un-compared range.
 *
 * CI REACHABILITY (.claude/rules/test.md -> "Cross-package parity tests must be
 * CI-reachable"): CLOSED. `.github/workflows/cicd.yml` -> `changes.worker`
 * filters on `worker/**`, `shared/**`, `scripts/**`, the workflow file, and --
 * added alongside this guard, mirroring the `extension` / `pwa` filters --
 * `package.json` and `pnpm-lock.yaml`. Those last two are what make the guard
 * reachable on the change class it exists to catch: a lockfile-only wrangler
 * bump, or an edit to the root `engines.node` alone, now triggers
 * `worker-check`. Removing either filter entry silently blinds this file.
 *
 * MUTATION-CHECKED at authoring time (test.md -> "Guard tests must prove they
 * can fail"): driven through the seam below against fixture package.json files,
 * a declared `>=20` against a demanded `>=22.0.0` goes RED naming both values,
 * and `>=22` goes green.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * MUTATION-CHECK SEAM (same device as `kvAccessBoundary.test.ts`'s scan roots).
 * Both paths are overridable purely so the comparison can be driven RED against
 * throwaway fixture files at authoring time, WITHOUT editing the live root
 * `package.json`. CI sets neither variable. The "file exists / field is a
 * non-empty parseable range" assertions below catch a seam value pointing at
 * NOTHING -- that throws, loudly. They do not catch a seam value pointing at
 * VALID fixtures: that is the intended mutation-check use, and the guard then
 * compares the fixtures rather than the repo, undetected.
 */
const ROOT_PACKAGE_JSON =
  process.env.MOO_NODE_ENGINE_ROOT_PACKAGE_JSON ??
  resolve(HERE, "../../../package.json");

const WRANGLER_PACKAGE_JSON =
  process.env.MOO_NODE_ENGINE_WRANGLER_PACKAGE_JSON ??
  resolve(HERE, "../../node_modules/wrangler/package.json");

/** A `>=` range's lower bound as `[major, minor, patch]`, zero-filled. */
type VersionTuple = readonly [number, number, number];

/** The only range shape either file uses today: `>=X`, `>=X.Y`, `>=X.Y.Z`. */
const MINIMUM_RANGE_PATTERN = /^>=\s*(\d+(?:\.\d+){0,2})$/;

/**
 * The raw `engines.node` value of a package.json. Deliberately UNVALIDATED --
 * the companion test asserts its shape, so a deleted field surfaces as a named
 * assertion failure instead of being swallowed by a throw in here. A missing
 * FILE does throw: that is a broken guard, not a drifted floor.
 */
function readEnginesNode(file: string, label: string): unknown {
  if (!existsSync(file)) {
    throw new Error(
      `${label} package.json not found at ${file}. This guard cannot compare ` +
        `Node floors without it -- run "pnpm install" or fix the path; do not ` +
        `delete the check.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return (parsed as { engines?: { node?: unknown } }).engines?.node;
}

/** Narrows a raw `engines.node` to a non-empty string, or fails loudly. */
function requireRange(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${label} package.json declares no non-empty engines.node. The floor ` +
        `must stay declared -- a missing field makes this comparison vacuous.`,
    );
  }
  return value;
}

function parseMinimumVersion(range: string, label: string): VersionTuple {
  const match = MINIMUM_RANGE_PATTERN.exec(range.trim());
  if (!match) {
    throw new Error(
      `${label} engines.node is "${range}", a range shape this guard's parser ` +
        `does not understand. It handles simple ">=X[.Y[.Z]]" only -- extend ` +
        `parseMinimumVersion() to cover the new shape. Never relax this into a ` +
        `silent pass: an un-compared range guards nothing.`,
    );
  }
  const parts = match[1].split(".").map((part) => Number.parseInt(part, 10));
  return [
    parts[0],
    parts.length > 1 ? parts[1] : 0,
    parts.length > 2 ? parts[2] : 0,
  ];
}

/** Negative / zero / positive, like any comparator. */
function compareVersions(a: VersionTuple, b: VersionTuple): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function formatVersion(version: VersionTuple): string {
  return version.join(".");
}

describe("declared Node engine floor vs. the floor wrangler demands", () => {
  it("resolves both package.json files and reads a parseable engines.node range from each", () => {
    // Positive companion (test.md): a moved file, a deleted `engines` field or
    // a range shape nothing compares would otherwise let the guard below pass
    // while proving nothing.
    expect(
      existsSync(WRANGLER_PACKAGE_JSON),
      `wrangler package.json must exist at ${WRANGLER_PACKAGE_JSON}`,
    ).toBe(true);
    expect(
      existsSync(ROOT_PACKAGE_JSON),
      `root package.json must exist at ${ROOT_PACKAGE_JSON}`,
    ).toBe(true);

    const wranglerRange = readEnginesNode(WRANGLER_PACKAGE_JSON, "wrangler");
    const rootRange = readEnginesNode(ROOT_PACKAGE_JSON, "root");

    expect(typeof wranglerRange, "wrangler engines.node must be a string").toBe(
      "string",
    );
    expect(typeof rootRange, "root engines.node must be a string").toBe(
      "string",
    );
    expect(wranglerRange, "wrangler engines.node must be non-empty").toMatch(
      /\S/,
    );
    expect(rootRange, "root engines.node must be non-empty").toMatch(/\S/);

    expect(() =>
      parseMinimumVersion(requireRange(wranglerRange, "wrangler"), "wrangler"),
    ).not.toThrow();
    expect(() =>
      parseMinimumVersion(requireRange(rootRange, "root"), "root"),
    ).not.toThrow();
  });

  it("declares a Node floor at least as high as the installed wrangler requires", () => {
    const wranglerRange = requireRange(
      readEnginesNode(WRANGLER_PACKAGE_JSON, "wrangler"),
      "wrangler",
    );
    const rootRange = requireRange(
      readEnginesNode(ROOT_PACKAGE_JSON, "root"),
      "root",
    );
    const demanded = parseMinimumVersion(wranglerRange, "wrangler");
    const declared = parseMinimumVersion(rootRange, "root");

    expect(
      compareVersions(declared, demanded),
      `Root package.json declares engines.node "${rootRange}" (floor ` +
        `${formatVersion(declared)}), but the installed wrangler requires ` +
        `engines.node "${wranglerRange}" (floor ${formatVersion(demanded)}). ` +
        `Everyone sitting on the declared floor gets a hard failure from every ` +
        `wrangler command, while CI (Node 22) stays green. Raise the root ` +
        `engines.node -- and the docs quoting it -- to match.`,
    ).toBeGreaterThanOrEqual(0);
  });
});
