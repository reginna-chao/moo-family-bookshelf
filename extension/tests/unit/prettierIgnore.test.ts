import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pins `extension/.prettierignore`. Prettier v3 resolves its ignore file from
 * the process CWD only — it never searches upward — so the repo-root
 * `.prettierignore` does not apply when prettier runs with cwd = `extension/`.
 * These two git-tracked files are generated verbatim by their owning scripts; a
 * prettier run from the extension package root must not want to rewrite them.
 * Deleting `extension/.prettierignore`, or dropping either entry from it, makes
 * prettier flag both files and this check exits non-zero.
 *
 * Also pins the repo-root `.prettierignore`'s `.claude/runs/` entry (#441).
 * `/develop` run files (`.claude/runs/<slug>/PLAN.md`) are appended to by the
 * orchestrator and Prettier would rewrite their Traditional Chinese tables and
 * lists; a PLAN.md kept at the commit gate must not turn CI's `format` job
 * (`prettier --check .` from the repo root) red. `--file-info` consults only the
 * ignore file, so the probed path need not exist on disk.
 *
 * Path resolution: `extensionRoot` is resolved from `import.meta.url` as a
 * STRING — Vite rewrites the literal `new URL("...", import.meta.url)` form into
 * a served asset URL (`http://localhost:3000/@fs/...`), which `fileURLToPath`
 * then rejects. prettier is a devDependency of the workspace ROOT only, and
 * pnpm's strict node_modules layout leaves it unresolvable from the extension
 * package, so the CLI script is resolved through the repo root and run on
 * `process.execPath` — no platform-specific `.bin` shim or shell quoting is
 * involved.
 */

// Generated verbatim by their owning scripts; prettier must not want to rewrite
// them. See the file header.
const GENERATED_FILES = [
  "public/manifest.json",
  "tests/e2e/fixtures/mock-readmoo.html",
];

// Resolve from `import.meta.url` as a STRING (Vite rewrites the `new URL(...)`
// form into a served asset URL). See the header → "Path resolution".
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(extensionRoot, "..");

// prettier lives in the ROOT workspace only: resolve its CLI from the repo root,
// run it on `process.execPath`. See the header → "Path resolution".
const require_ = createRequire(import.meta.url);
const prettierCli = require_.resolve("prettier/bin/prettier.cjs", {
  paths: [repoRoot],
});

describe("extension/.prettierignore", () => {
  it("leaves generated files unformatted when prettier checks them from the extension root", () => {
    try {
      execFileSync(
        process.execPath,
        [prettierCli, "--check", ...GENERATED_FILES],
        { cwd: extensionRoot, encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      const { stdout, stderr } = error as {
        stdout?: string;
        stderr?: string;
      };
      expect.fail(
        "prettier --check wanted to rewrite generated files from cwd=extension/. " +
          "Is extension/.prettierignore missing or incomplete?\n" +
          `${stdout ?? ""}${stderr ?? ""}`,
      );
    }
  });
});

describe("repo-root .prettierignore", () => {
  it("ignores /develop run files under .claude/runs/ when prettier runs from the repo root", () => {
    // The path need not exist: --file-info only consults the ignore file.
    const stdout = execFileSync(
      process.execPath,
      [prettierCli, "--file-info", ".claude/runs/some-slug/PLAN.md"],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
    );
    const info = JSON.parse(stdout) as { ignored: boolean };
    expect(
      info.ignored,
      "repo-root .prettierignore must list .claude/runs/ (see the file header)",
    ).toBe(true);
  });
});
