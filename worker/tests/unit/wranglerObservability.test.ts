/**
 * `worker/wrangler.toml` — the Workers Logs settings this repo SHIPS (#357).
 *
 * WHY A TEST READS A CONFIG FILE. Cloudflare invocation logs record every
 * request URL, and the /api paths carry identifiers: `/api/family/:id/…` (the
 * familyId IS the sync code), `/api/user/:id/…` (a userId, which
 * `POST /api/auth/lookup` turns into a familyId) and `/api/public/:shareToken`.
 * `invocation_logs = false` is the only thing keeping those URLs out of Workers
 * Logs, and nothing at runtime can see it: wrangler never reports the deployed
 * configuration back, and no Worker code reads it. Deleting or flipping the
 * line leaves every other test green — this file is where that is caught.
 *
 * WHAT IT PINS, for BOTH declared sets — the top-level `[observability]` used
 * by `wrangler deploy` / `wrangler dev`, and `[env.production.observability]`,
 * which REPLACES the top-level block instead of merging with it, so its own
 * `.logs` sub-table has to repeat the flag:
 *
 * - `enabled = true` — the Worker's own `console.*` lines (error tags, the
 *   per-request `kv_ops` line) still reach Workers Logs;
 * - `logs.invocation_logs = false`.
 *
 * NOT COVERED: `wrangler.backup.toml` (a separate Cron-only Worker with no
 * request URLs, deliberately not asserted on), a self-hoster's edited copy, and
 * whether Cloudflare honours the flag — the platform is unobservable from here.
 *
 * PARSING IS HAND-ROLLED, for the reason given in wranglerRateLimits.test.ts
 * (no TOML parser in this workspace; one test does not justify a dependency).
 * The reader understands `[table]` headers and `key = value` lines only; an
 * `[[array]]` header ends the current table, and a repeated header throws. A
 * flag re-spelled in another valid TOML form (a dotted `logs.invocation_logs`
 * key under `[observability]`, an inline table) reads as `undefined` and fails
 * here loudly rather than pinning nothing. Values are compared as raw TOML
 * literals (`"true"` / `"false"`), never coerced.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML_PATH = resolve(HERE, "../../wrangler.toml");

// Drops a trailing `# ...` comment; a `#` inside a quoted string is kept.
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inString = !inString;
    else if (line[i] === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

const ARRAY_HEADER_RE = /^\[\[[^\]]+\]\]$/;
const TABLE_HEADER_RE = /^\[([^\]]+)\]$/;
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;

/** Every `[table]`'s raw fields, keyed by dotted header path. See the header → "PARSING". */
function readTables(toml: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;

  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (line === "") continue;

    if (ARRAY_HEADER_RE.test(line)) {
      current = null;
      continue;
    }
    const header = TABLE_HEADER_RE.exec(line);
    if (header) {
      const name = header[1].trim();
      if (tables.has(name)) {
        throw new Error(`wrangler.toml:${i + 1} — duplicate [${name}]`);
      }
      current = new Map();
      tables.set(name, current);
      continue;
    }

    const field = FIELD_RE.exec(line);
    if (field && current) current.set(field[1], field[2].trim());
  }

  return tables;
}

const TABLES = readTables(readFileSync(WRANGLER_TOML_PATH, "utf8"));

describe("wrangler.toml observability", () => {
  it.each([
    { set: "the top-level (dev) set", table: "observability" },
    { set: "[env.production]", table: "env.production.observability" },
  ])("keeps Workers Logs on and invocation logs off in $set", ({ table }) => {
    expect(TABLES.get(table)?.get("enabled")).toBe("true");
    expect(TABLES.get(`${table}.logs`)?.get("invocation_logs")).toBe("false");
  });
});
