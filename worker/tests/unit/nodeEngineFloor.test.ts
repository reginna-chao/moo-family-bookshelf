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
 * WHAT IT PINS. Exactly two properties, both "a version the root
 * `package.json` declares vs. a version something else actually uses":
 *
 *   1. The floor the repo DECLARES must satisfy the floor wrangler DEMANDS.
 *      Both are read off disk -- the declaration from the root `package.json`,
 *      the demand from the INSTALLED `worker/node_modules/wrangler/package.json`
 *      (resolved relative to this file, never via `process.cwd()`), so a
 *      dependency bump that raises wrangler's requirement fails here instead
 *      of in a self-hoster's terminal.
 *
 *   2. The root `Dockerfile` (the long-term reproducible dev environment) must
 *      agree with the root `package.json`: its `RUN npm install -g pnpm@<v>`
 *      installs exactly the version `packageManager` names, its single
 *      `FROM node:<tag>` base image satisfies `engines.node`, and that image
 *      is pinned by an `@sha256:` digest. The pin is the point of the file --
 *      a bare tag floats, and an image rebuilt years later on a different
 *      Node / Debian is exactly what the Dockerfile exists to avoid. Nothing
 *      else compares these: `docker compose build` happily installs a pnpm
 *      that disagrees with `packageManager`, and a floating tag builds green.
 *      The image tag is compared only to the precision it states: `node:22`
 *      floats over every 22.x, so it is compared to the floor's major alone,
 *      while `node:22.3` is compared to the floor's major.minor.
 *
 * KNOWN BOUNDARY. Property 1 compares root `engines.node` vs the INSTALLED
 * wrangler, nothing else: `vitest`, `typescript`, `@cloudflare/workers-types`
 * and the extension / PWA devDependencies go uncompared, so a bump raising one
 * of THEIR Node floors still relies on a human reading `engines` afterwards.
 * Extending means iterating a list of packages -- deliberately left out.
 * Property 2 reads only the ONE `FROM node:` line and the ONE
 * `RUN npm install -g pnpm@` line (more than one of either throws); it checks
 * that a digest is PRESENT and well-formed, not that it really is a Node image
 * of that version -- a digest copied from the wrong tag goes unnoticed until
 * `docker compose build`.
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
 * The Dockerfile half is reachable a different way: `Dockerfile` is NOT in the
 * `worker` filter (that output also gates `deploy-worker-dev`, and a
 * Dockerfile-only merge must not redeploy an unchanged Worker). Instead
 * `worker-check`'s job-level `if:` also accepts `needs.changes.outputs.docker`,
 * whose filter lists `Dockerfile`, `package.json` and `pnpm-lock.yaml` -- so a
 * Dockerfile-only PR, or a `packageManager` bump alone, runs this file. Both
 * the clause and those globs are pinned by `ciSuccessGate.test.ts`
 * ("changes job path filter globs").
 *
 * MUTATION-CHECKED at authoring time (test.md -> "Guard tests must prove they
 * can fail"): driven through the seam below against fixture package.json files,
 * a declared `>=20` against a demanded `>=22.0.0` goes RED naming both values,
 * and `>=22` goes green. Driven through `MOO_DOCKERFILE_PATH` against scratch
 * copies of the Dockerfile, `pnpm@11.1.1`, `FROM node:20-slim@sha256:...` and
 * a `FROM` line with its digest stripped each turn exactly the matching case
 * RED; the pre-change Dockerfile (corepack, no digest) fails the shape
 * companion, the pnpm case and the digest case.
 *
 * MUTATION-CHECK SEAM (same device as `kvAccessBoundary.test.ts`'s scan roots):
 * `ROOT_PACKAGE_JSON` / `WRANGLER_PACKAGE_JSON` / `DOCKERFILE` are overridable
 * through `MOO_NODE_ENGINE_*` / `MOO_DOCKERFILE_PATH` env variables purely so
 * the comparisons can be driven RED against throwaway fixture files at
 * authoring time, WITHOUT editing the live root files. CI sets none of them. The "file exists / field is a
 * non-empty parseable range" assertions below catch a seam value pointing at
 * NOTHING -- that throws, loudly. They do not catch a seam value pointing at
 * VALID fixtures: that is the intended mutation-check use, and the guard then
 * compares the fixtures rather than the repo, undetected.
 *
 * `readEnginesNode()` / `readPackageManager()` return the raw field value,
 * deliberately UNVALIDATED -- the companion tests assert its shape, so a
 * deleted field surfaces as a named assertion failure instead of being
 * swallowed by a throw in there. A missing FILE does throw (the Dockerfile
 * too): that is a broken guard, not a drifted version.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mutation-check seam: all three paths are env-overridable for fixture runs; CI sets none.
// See the header → "MUTATION-CHECK SEAM".
const ROOT_PACKAGE_JSON =
  process.env.MOO_NODE_ENGINE_ROOT_PACKAGE_JSON ??
  resolve(HERE, "../../../package.json");

const WRANGLER_PACKAGE_JSON =
  process.env.MOO_NODE_ENGINE_WRANGLER_PACKAGE_JSON ??
  resolve(HERE, "../../node_modules/wrangler/package.json");

const DOCKERFILE =
  process.env.MOO_DOCKERFILE_PATH ?? resolve(HERE, "../../../Dockerfile");

/** A `>=` range's lower bound as `[major, minor, patch]`, zero-filled. */
type VersionTuple = readonly [number, number, number];

/** The only range shape either file uses today: `>=X`, `>=X.Y`, `>=X.Y.Z`. */
const MINIMUM_RANGE_PATTERN = /^>=\s*(\d+(?:\.\d+){0,2})$/;

/** The two package.json fields this file reads, both unvalidated. */
interface PackageJsonFields {
  engines?: { node?: unknown };
  packageManager?: unknown;
}

/** A package.json parsed as UNVALIDATED JSON; a missing FILE throws loudly. */
function readPackageJson(file: string, label: string): PackageJsonFields {
  if (!existsSync(file)) {
    throw new Error(
      `${label} package.json not found at ${file}. This guard cannot compare ` +
        `versions without it -- run "pnpm install" or fix the path; do not ` +
        `delete the check.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed as PackageJsonFields;
}

// The raw `engines.node` value, deliberately UNVALIDATED; a missing FILE throws.
// See the header → "`readEnginesNode()` / `readPackageManager()`".
function readEnginesNode(file: string, label: string): unknown {
  return readPackageJson(file, label).engines?.node;
}

// The raw `packageManager` value, deliberately UNVALIDATED; a missing FILE throws.
// See the header → "`readEnginesNode()` / `readPackageManager()`".
function readPackageManager(file: string, label: string): unknown {
  return readPackageJson(file, label).packageManager;
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

// --- The Dockerfile half (property 2) ---

/** `pnpm@X.Y.Z`, optionally with corepack's `+sha…` integrity suffix. */
const PACKAGE_MANAGER_PATTERN = /^pnpm@(\d+\.\d+\.\d+)(?:\+\S+)?$/;

/** The pnpm install line; `[^\S\n]` keeps a match on its own line. */
const PNPM_INSTALL_LINE =
  /^RUN[^\S\n]+npm[^\S\n]+install[^\S\n]+-g[^\S\n]+pnpm@(\S+)[^\S\n]*$/gm;

/** A `FROM node:…` line, with or without `AS <stage>`; `FROM base AS …` never matches. */
const NODE_FROM_LINE =
  /^FROM[^\S\n]+(node:\S+)(?:[^\S\n]+AS[^\S\n]+\S+)?[^\S\n]*$/gim;

/** `node:<version>[-<variant>][@sha256:<digest>]`; the digest's SHAPE is a test of its own. */
const NODE_IMAGE_PATTERN =
  /^node:(\d+(?:\.\d+){0,2})(?:-[A-Za-z0-9._-]+)?(?:@sha256:([^\s@]*))?$/;

/** Reads the Dockerfile as UTF-8, CRLF-normalised; throws loudly when absent. */
function readDockerfile(file: string): string {
  if (!existsSync(file)) {
    throw new Error(
      `Dockerfile not found at ${file}. This guard cannot compare the image's ` +
        `pnpm / Node versions without it -- fix the path; do not delete the check.`,
    );
  }
  return readFileSync(file, "utf8").split("\r\n").join("\n");
}

/** The ONE line `pattern` matches; zero or several throw, naming `label`. */
function soleLine(source: string, pattern: RegExp, label: string): string[] {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${label} line in the Dockerfile, found ` +
        `${matches.length}. With none the version goes uncompared; with ` +
        `several this guard would read only one of them.`,
    );
  }
  return [...matches[0]];
}

/** The version `RUN npm install -g pnpm@<v>` installs. */
function dockerPnpmVersion(dockerfile: string): string {
  return soleLine(
    dockerfile,
    PNPM_INSTALL_LINE,
    "`RUN npm install -g pnpm@…`",
  )[1];
}

/** The base image's tag version (as stated, 1–3 parts) and its digest, if any. */
function dockerNodeImage(dockerfile: string): {
  ref: string;
  version: number[];
  digest: string | undefined;
} {
  const ref = soleLine(dockerfile, NODE_FROM_LINE, "`FROM node:…`")[1];
  const match = NODE_IMAGE_PATTERN.exec(ref);
  if (!match) {
    throw new Error(
      `Dockerfile base image "${ref}" has no numeric Node version tag this ` +
        `guard can compare (e.g. "node:22-slim"). A codename or "lts" tag ` +
        `cannot be checked against engines.node -- extend the parser.`,
    );
  }
  const version = match[1].split(".").map((part) => Number.parseInt(part, 10));
  return { ref, version, digest: match[2] };
}

/** Like `compareVersions`, over only the parts `stated` gives (`[22]` vs `22.5.0` ⇒ 0). */
function compareStatedPrefix(stated: number[], floor: VersionTuple): number {
  for (let index = 0; index < stated.length; index += 1) {
    if (stated[index] !== floor[index]) return stated[index] - floor[index];
  }
  return 0;
}

/** Narrows root `packageManager` to its pnpm version, or fails loudly. */
function requirePnpmPin(value: unknown): string {
  const match =
    typeof value === "string" ? PACKAGE_MANAGER_PATTERN.exec(value) : null;
  if (!match) {
    throw new Error(
      `Root package.json packageManager is ${JSON.stringify(value)}; this ` +
        `guard expects "pnpm@X.Y.Z". Without it the Dockerfile's pnpm goes ` +
        `uncompared.`,
    );
  }
  return match[1];
}

describe("declared Node engine floor vs. the floor wrangler demands", () => {
  it("resolves both package.json files and reads a parseable engines.node range from each", () => {
    // Positive companion (test.md): a moved file, a deleted `engines` field or an uncompared
    // range shape would otherwise let the guard below pass while proving nothing.
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

describe("Dockerfile toolchain versions vs. root package.json", () => {
  it("reads one pnpm install line and one Node base image from the Dockerfile", () => {
    // Positive companion: a moved Dockerfile, or a reshaped line the patterns no longer see,
    // would otherwise leave the three cases below comparing nothing.
    expect(
      existsSync(DOCKERFILE),
      `Dockerfile must exist at ${DOCKERFILE}`,
    ).toBe(true);
    const dockerfile = readDockerfile(DOCKERFILE);
    expect(() => dockerPnpmVersion(dockerfile)).not.toThrow();
    expect(() => dockerNodeImage(dockerfile)).not.toThrow();
    expect(() =>
      requirePnpmPin(readPackageManager(ROOT_PACKAGE_JSON, "root")),
    ).not.toThrow();
  });

  it("installs exactly the pnpm version root packageManager names", () => {
    const pinned = requirePnpmPin(
      readPackageManager(ROOT_PACKAGE_JSON, "root"),
    );
    const installed = dockerPnpmVersion(readDockerfile(DOCKERFILE));
    expect(
      installed,
      `Dockerfile installs pnpm@${installed}, but root package.json ` +
        `packageManager names pnpm@${pinned}. Bump both together.`,
    ).toBe(pinned);
  });

  it("builds on a Node image whose version satisfies root engines.node", () => {
    // Compared only to the precision the tag states: `node:22` floats over every 22.x.
    // See the header → "WHAT IT PINS", property 2.
    const rootRange = requireRange(
      readEnginesNode(ROOT_PACKAGE_JSON, "root"),
      "root",
    );
    const floor = parseMinimumVersion(rootRange, "root");
    const image = dockerNodeImage(readDockerfile(DOCKERFILE));
    expect(
      compareStatedPrefix(image.version, floor),
      `Dockerfile base image "${image.ref}" (Node ${image.version.join(".")}) ` +
        `is below root engines.node "${rootRange}" (floor ` +
        `${formatVersion(floor)}). Raise the FROM tag -- and its digest -- to match.`,
    ).toBeGreaterThanOrEqual(0);
  });

  it("pins the Node base image by a sha256 digest", () => {
    // A bare tag floats; the digest is what makes a rebuild years later the same image.
    // See the header → "WHAT IT PINS", property 2.
    const image = dockerNodeImage(readDockerfile(DOCKERFILE));
    expect(
      image.digest ?? "(no digest)",
      `Dockerfile base image "${image.ref}" is not pinned by @sha256:<digest>. ` +
        `Refresh it with \`docker buildx imagetools inspect <tag>\`.`,
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
