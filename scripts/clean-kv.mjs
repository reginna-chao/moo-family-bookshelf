#!/usr/bin/env node
/**
 * Clean all keys from a Cloudflare KV namespace.
 *
 * Usage:
 *   node scripts/clean-kv.mjs <namespace-id>
 *   node scripts/clean-kv.mjs dev   → auto-resolves dev namespace via `wrangler kv namespace list`
 *   node scripts/clean-kv.mjs prod  → auto-resolves prod namespace
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Invoke wrangler's JS entry directly via the current Node binary. Avoids the
// platform-specific shims in node_modules/.bin: on Windows Node 20+ refuses to
// execFile() .CMD shims (CVE-2024-27980), and the extension-less shell script
// cannot be executed at all.
const workerDir = resolve(__dirname, "../worker");
const wranglerEntry = resolve(
  workerDir,
  "node_modules/wrangler/bin/wrangler.js",
);

function runWrangler(args, options = {}) {
  // cwd must be the worker/ directory so wrangler picks up wrangler.toml
  // (account_id, env) instead of running with no context from the repo root.
  return execFileSync(process.execPath, [wranglerEntry, ...args], {
    cwd: workerDir,
    ...options,
  });
}

const ALIAS_PATTERNS = {
  dev: /dev-kv$/,
  prod: /prod-kv$/,
};

/** UUID v4 format used by Cloudflare KV namespace IDs. */
const UUID_RE = /^[0-9a-f]{32}$/;

/**
 * Safely parse JSON from wrangler output.
 * Wrangler sometimes prepends warnings/banners before the JSON payload.
 */
function safeParseJson(raw) {
  // Find the first '[' or '{' to skip any wrangler banner text
  const arrStart = raw.indexOf("[");
  const objStart = raw.indexOf("{");
  let start = -1;
  if (arrStart !== -1 && objStart !== -1) {
    start = Math.min(arrStart, objStart);
  } else {
    start = arrStart !== -1 ? arrStart : objStart;
  }

  if (start === -1) {
    throw new Error(
      `Could not find JSON in wrangler output:\n${raw.slice(0, 200)}`,
    );
  }
  return JSON.parse(raw.slice(start));
}

/**
 * Resolve a namespace alias (dev/prod) to its UUID by querying the Cloudflare API.
 * Falls back to using the input as-is if it's not a known alias.
 */
function resolveNamespaceId(input) {
  const pattern = ALIAS_PATTERNS[input];
  if (!pattern) {
    // Direct namespace ID — validate format
    if (!UUID_RE.test(input)) {
      console.error(
        `Invalid namespace ID format: "${input}". Expected a 32-char hex UUID or alias (dev/prod).`,
      );
      process.exit(1);
    }
    return input;
  }

  const raw = runWrangler(["kv", "namespace", "list"], { encoding: "utf-8" });
  const namespaces = safeParseJson(raw);
  const match = namespaces.find((ns) => pattern.test(ns.title));

  if (!match) {
    console.error(`Could not find a KV namespace matching alias "${input}".`);
    console.error(
      "Available namespaces:",
      namespaces.map((ns) => `  ${ns.title} (${ns.id})`).join("\n"),
    );
    process.exit(1);
  }

  return match.id;
}

const input = process.argv[2];

if (!input) {
  console.error("Usage: node scripts/clean-kv.mjs <dev|prod|namespace-id>");
  process.exit(1);
}

const namespaceId = resolveNamespaceId(input);
const label = ALIAS_PATTERNS[input] ? `${input} (${namespaceId})` : namespaceId;

console.log(`Listing keys in KV namespace: ${label}`);

const raw = runWrangler(
  ["kv", "key", "list", `--namespace-id=${namespaceId}`],
  { encoding: "utf-8" },
);

const keys = safeParseJson(raw).map((k) => k.name);

if (keys.length === 0) {
  console.log("No keys found. Nothing to delete.");
  process.exit(0);
}

console.log(`Found ${keys.length} key(s). Deleting...`);

// wrangler kv bulk delete requires a file path (not stdin)
const tmpDir = resolve(__dirname, "../worker/.wrangler");
mkdirSync(tmpDir, { recursive: true });
const tmpFile = resolve(tmpDir, ".kv-delete-tmp.json");
try {
  writeFileSync(tmpFile, JSON.stringify(keys));
  runWrangler(
    [
      "kv",
      "bulk",
      "delete",
      tmpFile,
      `--namespace-id=${namespaceId}`,
      "--force",
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
} finally {
  try {
    unlinkSync(tmpFile);
  } catch {
    // ignore cleanup errors
  }
}

console.log(`Done. Deleted ${keys.length} key(s).`);
