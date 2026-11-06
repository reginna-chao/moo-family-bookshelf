import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SWEEP_INTERVAL_MS } from "../../src/services/accountDeletionSweep";

/**
 * `worker/wrangler.toml` — the account-deletion sweep's cron (#468).
 *
 * WHY A TEST READS A CONFIG FILE. The sweep is the main guarantee that data written back
 * after an account deletion goes away, and nothing at runtime can see whether its cron
 * is deployed: with the line gone every other test stays green and the marks simply
 * expire with the leftovers still in KV (`docs/architecture.md` → 已接受的殘餘風險).
 *
 * WHAT IT PINS. `[env.production.triggers]` carries exactly the one cron, and its period
 * equals `SWEEP_INTERVAL_MS`, which the rotation assumes. The top level has no trigger
 * at all: KV list operations are shared across the Cloudflare account, and a dev cron
 * would double the daily count. A cron on `wrangler dev` is still reachable by hand.
 *
 * NOT COVERED: a self-hoster's edited copy, and whether Cloudflare runs it. That the
 * config parses and the `scheduled` handler runs on a real runtime is checked by
 * `wrangler deploy --dry-run` and `wrangler dev --test-scheduled`, by hand.
 *
 * PARSING IS HAND-ROLLED, for the reason in `wranglerRateLimits.test.ts` (no TOML parser
 * in this workspace; one test does not justify a dependency). The reader understands
 * `[table]` headers and `key = value` lines only, and values stay raw TOML literals.
 * A cron re-spelled in another valid TOML form reads as absent and fails loudly.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML_PATH = resolve(HERE, "../../wrangler.toml");

const TABLE_HEADER_RE = /^\[([^[\]]+)\]$/;
const ARRAY_HEADER_RE = /^\[\[[^\]]+\]\]$/;
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;

/** Every `[table]`'s raw fields, keyed by dotted header path; `""` is the top level. */
function readTables(toml: string): Map<string, Map<string, string>> {
  let current = new Map<string, string>();
  const tables = new Map<string, Map<string, string>>([["", current]]);
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (line === "") continue;
    if (ARRAY_HEADER_RE.test(line)) {
      current = new Map();
      continue;
    }
    const header = TABLE_HEADER_RE.exec(line);
    if (header) {
      current = new Map();
      tables.set(header[1].trim(), current);
      continue;
    }
    const field = FIELD_RE.exec(line);
    if (field) current.set(field[1], field[2].trim());
  }
  return tables;
}

const TABLES = readTables(readFileSync(WRANGLER_TOML_PATH, "utf8"));

describe("wrangler.toml triggers", () => {
  it("runs the sweep's cron on production", () => {
    expect(TABLES.get("env.production.triggers")?.get("crons")).toBe(
      '["*/30 * * * *"]',
    );
  });

  it("keeps the rotation's interval equal to that cron's period", () => {
    expect(SWEEP_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  it("declares no trigger at the top level, so dev pays no list operations", () => {
    expect(TABLES.has("triggers")).toBe(false);
    expect(TABLES.get("")?.has("crons")).toBe(false);
    expect(TABLES.get("")?.has("triggers")).toBe(false);
  });

  it("reads the top level at all, so the two assertions above cannot pass on an empty parse", () => {
    expect(TABLES.get("")?.get("main")).toBeDefined();
    expect(TABLES.has("env.production.observability")).toBe(true);
  });
});
