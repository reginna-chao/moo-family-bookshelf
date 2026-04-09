#!/usr/bin/env node
/**
 * Clean all keys from a Cloudflare KV namespace.
 *
 * Usage:
 *   node scripts/clean-kv.mjs <namespace-id>
 *   node scripts/clean-kv.mjs dev   → auto-resolves dev namespace via `wrangler kv namespace list`
 *   node scripts/clean-kv.mjs prod  → auto-resolves prod namespace
 */
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrangler = resolve(__dirname, "../worker/node_modules/.bin/wrangler");

const ALIAS_PATTERNS = {
  dev: /dev-kv$/,
  prod: /prod-kv$/,
};

/**
 * Resolve a namespace alias (dev/prod) to its UUID by querying the Cloudflare API.
 * Falls back to using the input as-is if it's not a known alias.
 */
function resolveNamespaceId(input) {
  const pattern = ALIAS_PATTERNS[input];
  if (!pattern) return input;

  const raw = execSync(`${wrangler} kv namespace list`, { encoding: "utf-8" });
  const namespaces = JSON.parse(raw);
  const match = namespaces.find((ns) => pattern.test(ns.title));

  if (!match) {
    console.error(
      `Could not find a KV namespace matching alias "${input}".`,
    );
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

const raw = execSync(
  `${wrangler} kv key list --namespace-id=${namespaceId}`,
  { encoding: "utf-8" },
);

const keys = JSON.parse(raw).map((k) => k.name);

if (keys.length === 0) {
  console.log("No keys found. Nothing to delete.");
  process.exit(0);
}

console.log(`Found ${keys.length} key(s). Deleting...`);

// wrangler kv bulk delete requires a file path (not stdin)
const tmpFile = resolve(__dirname, "../worker/.wrangler/.kv-delete-tmp.json");
try {
  writeFileSync(tmpFile, JSON.stringify(keys));
  execSync(
    `${wrangler} kv bulk delete ${tmpFile} --namespace-id=${namespaceId} --force`,
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
