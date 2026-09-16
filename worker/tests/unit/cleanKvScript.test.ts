/**
 * Regression test for `scripts/clean-kv.mjs` after the wrangler 3 → 4 upgrade
 * (#175 / #189).
 *
 * Wrangler 4 flipped the KV DATA commands (`kv key *`, `kv bulk *`) to
 * local-by-default: without `--remote` they hit the local Miniflare store.
 * The script resolves a REMOTE namespace id, so a missing flag makes it list
 * the (empty) local store, print "No keys found. Nothing to delete." and exit
 * 0 while the Cloudflare namespace is untouched — a silent no-op. This test
 * spawns the REAL script with `execFileSync` swapped out by a preload shim and
 * pins `--remote` on both data commands.
 *
 * The shim is written to a temp dir at run time rather than checked in under
 * `tests/helpers/`: it must be plain `.mjs` for `node --import`, and the
 * typed ESLint parser rejects any file outside `tsconfig.json`'s project.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = resolve(repoRoot, "scripts/clean-kv.mjs");
const scriptTmpFile = resolve(repoRoot, "worker/.wrangler/.kv-delete-tmp.json");

const NAMESPACE_ID = "0123456789abcdef0123456789abcdef";

/**
 * Loaded via `node --import <shim> scripts/clean-kv.mjs <id>`. Replaces
 * `child_process.execFileSync` BEFORE the script's own named ESM import binds;
 * `syncBuiltinESMExports()` propagates the swap to that live binding, so the
 * real script runs end to end while every wrangler call is captured here and
 * none reaches Cloudflare (or the local Miniflare store).
 *
 * Each call's wrangler args (everything after `process.execPath`) is appended
 * as one JSON line to `$CLEAN_KV_TRACE_FILE`. `kv key list` answers a
 * non-empty key set so the script takes its delete branch; `kv bulk delete`
 * answers nothing; any other command throws, so an unexpected wrangler call
 * fails the run loudly instead of falling through to the real binary.
 */
const SHIM_SOURCE = `
import child_process from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const traceFile = process.env.CLEAN_KV_TRACE_FILE;
if (!traceFile) throw new Error("cleanKvShim: CLEAN_KV_TRACE_FILE is not set");

const CANNED_KEYS = JSON.stringify([{ name: "user:a" }, { name: "user:b" }]);

child_process.execFileSync = (_file, fileArgs) => {
  // fileArgs = [wranglerEntry, ...wranglerArgs]
  const args = fileArgs.slice(1);
  appendFileSync(traceFile, JSON.stringify(args) + "\\n");
  const command = args.slice(0, 3).join(" ");
  if (command === "kv key list") return CANNED_KEYS;
  if (command === "kv bulk delete") return "";
  throw new Error("cleanKvShim: unexpected wrangler call: " + args.join(" "));
};
syncBuiltinESMExports();
`;

describe("scripts/clean-kv.mjs", () => {
  let traceDir: string;

  beforeEach(() => {
    traceDir = mkdtempSync(join(tmpdir(), "clean-kv-trace-"));
  });

  afterEach(() => {
    rmSync(traceDir, { recursive: true, force: true });
  });

  it("targets the remote namespace on both the key list and the bulk delete", () => {
    const shimPath = join(traceDir, "cleanKvShim.mjs");
    const traceFile = join(traceDir, "calls.jsonl");
    writeFileSync(shimPath, SHIM_SOURCE);

    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(shimPath).href, scriptPath, NAMESPACE_ID],
      {
        cwd: repoRoot,
        env: { ...process.env, CLEAN_KV_TRACE_FILE: traceFile },
        encoding: "utf-8",
      },
    );

    // The delete branch must have executed, or the flag assertions below
    // would be vacuous. Not `toBe("")`: a future Node `ExperimentalWarning`
    // would land on stderr too, and that is not the script failing.
    expect(run.stderr).not.toMatch(/Error|cleanKvShim/);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Deleted 2 key(s)");

    const calls: string[][] = readFileSync(traceFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    const listCalls = calls.filter(
      (args) => args.slice(0, 3).join(" ") === "kv key list",
    );
    const deleteCalls = calls.filter(
      (args) => args.slice(0, 3).join(" ") === "kv bulk delete",
    );
    expect(listCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);

    for (const [command, args] of [
      ["kv key list", listCalls[0]],
      ["kv bulk delete", deleteCalls[0]],
    ] as const) {
      expect(args, `${command} must pass --remote`).toContain("--remote");
      expect(args, `${command} must target the resolved namespace`).toContain(
        `--namespace-id=${NAMESPACE_ID}`,
      );
    }

    // The script's own bulk-delete key file is removed in its `finally`.
    expect(existsSync(scriptTmpFile)).toBe(false);
  });
});
