#!/usr/bin/env node
/**
 * Clean all keys from a Cloudflare KV namespace.
 *
 * Usage:
 *   node scripts/clean-kv.mjs <namespace-id>
 *   node scripts/clean-kv.mjs dev   → uses dev KV namespace from wrangler.toml
 *   node scripts/clean-kv.mjs prod  → uses prod KV namespace from wrangler.toml
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrangler = resolve(__dirname, "../worker/node_modules/.bin/wrangler");

const NAMESPACES = (() => {
  const toml = readFileSync(
    resolve(__dirname, "../worker/wrangler.toml"),
    "utf-8",
  );
  const ids = [...toml.matchAll(/id\s*=\s*"([a-f0-9]+)"/g)].map((m) => m[1]);
  // First id = dev, second id (under env.production) = prod
  return { dev: ids[0], prod: ids[ids.length - 1] };
})();

const input = process.argv[2];

if (!input) {
  console.error("Usage: node scripts/clean-kv.mjs <dev|prod|namespace-id>");
  process.exit(1);
}

const namespaceId = NAMESPACES[input] ?? input;
const label = NAMESPACES[input] ? `${input} (${namespaceId})` : namespaceId;

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

execSync(`${wrangler} kv bulk delete --namespace-id=${namespaceId} --force`, {
  input: JSON.stringify(keys),
  stdio: ["pipe", "inherit", "inherit"],
});

console.log(`Done. Deleted ${keys.length} key(s).`);
