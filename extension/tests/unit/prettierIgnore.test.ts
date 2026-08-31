import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pins `extension/.prettierignore`. Prettier v3 resolves its ignore file from
// the process CWD only — it never searches upward — so the repo-root
// `.prettierignore` does not apply when prettier runs with cwd = `extension/`.
// These two git-tracked files are generated verbatim by their owning scripts;
// a prettier run from the extension package root must not want to rewrite them.
// Deleting `extension/.prettierignore`, or dropping either entry from it, makes
// prettier flag both files and this check exits non-zero.
const GENERATED_FILES = [
  "public/manifest.json",
  "tests/e2e/fixtures/mock-readmoo.html",
];

// Resolve from `import.meta.url` as a STRING. Vite rewrites the literal
// `new URL("...", import.meta.url)` form into a served asset URL
// (`http://localhost:3000/@fs/...`), which `fileURLToPath` then rejects.
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(extensionRoot, "..");

// prettier is a devDependency of the workspace ROOT only, and pnpm's strict
// node_modules layout leaves it unresolvable from the extension package.
// Resolve the CLI script through the repo root and run it on `process.execPath`
// so no platform-specific `.bin` shim or shell quoting is involved.
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
