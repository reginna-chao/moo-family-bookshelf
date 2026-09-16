/**
 * `worker/wrangler.toml` — the native Rate Limiting bindings this repo SHIPS.
 *
 * WHY A TEST READS A CONFIG FILE. Since #160 item 1 every per-minute ceiling is
 * counted by a Cloudflare Rate Limiting binding, and the NUMBER each binding
 * enforces lives in wrangler.toml, not in the Worker. Nothing at runtime can
 * see a mismatch between the two: `bindingForWindow` (src/middleware/
 * rateLimit.ts) resolves a binding by the limit the CODE intends, calls
 * `limit()` on it, and believes whatever the platform answers. So a
 * one-character typo in `simple = { limit = 3, period = 60 }` — 60 where 3 was
 * meant — deploys a sensitive tier that is silently 20x looser per Cloudflare
 * location, with every other test still green: the stubs in
 * tests/helpers/rateLimitBindings.ts do not count, and the platform never
 * reports its own configuration back. This file is the only place that mismatch
 * can be caught.
 *
 * WHAT IT PINS, for BOTH declared sets — the top-level one used by
 * `wrangler deploy` / `wrangler dev` and the `[env.production]` one, which is a
 * full copy because environments do NOT inherit top-level bindings:
 *
 * - exactly four `[[ratelimits]]` blocks (the official wrangler-4 form), named
 *   exactly the four members of `RateLimitBindingName` (src/utils/env.ts);
 * - `simple.limit` equal to the number the binding's own NAME encodes, and
 *   `simple.period` = 60;
 * - that `bindingForWindow` really routes a check at the toml's (limit, period)
 *   to the binding of that name — which ties the shipped number to production's
 *   `BINDING_BY_LIMIT` table without exporting it;
 * - `namespace_id` present, a positive integer, unique inside each set and
 *   disjoint between the two, so dev traffic cannot spend production's budget;
 * - no block left in the wrangler-3 spelling (`[[unsafe.bindings]]` +
 *   `type = "ratelimit"`), which wrangler 4 still accepts and would deploy
 *   alongside the new ones.
 *
 * WHAT IT DOES NOT COVER.
 *
 * - A self-hoster's edited copy. This guards the file in THIS repo only. A fork
 *   is on its own — and a deployment carrying no bindings at all still runs, on
 *   the KV counters, logging RATE_LIMIT_BINDING_MISSING (worker/DEPLOY.md).
 * - Whether Cloudflare enforces those numbers. Nothing local can observe the
 *   platform's counting; the whole point is that the config is unobservable.
 * - Collisions with another Worker in the same Cloudflare account: uniqueness
 *   is checked only within, and between, the two sets declared here.
 *
 * PARSING IS HAND-ROLLED, deliberately. No TOML parser is installed in this
 * workspace — `require.resolve` fails from worker/ for @iarna/toml, smol-toml,
 * toml and @ltd/j-toml, and the pnpm store holds no toml package at all
 * (wrangler bundles its own) — and one test does not justify a dependency. The
 * reader below understands exactly the shapes this file uses: `[[a.b.c]]`
 * array-of-tables headers, `key = "string"`, and
 * `simple = { limit = N, period = N }`. Anything else inside a ratelimit block
 * THROWS, so re-spelling the config in another valid TOML form fails loudly
 * here instead of quietly pinning nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { bindingForWindow } from "../../src/middleware/rateLimit";
import type { Env, RateLimitBindingName } from "../../src/utils/env";
import { createMockKV } from "../helpers/mockKv";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML_PATH = resolve(HERE, "../../wrangler.toml");

/**
 * The only period Cloudflare's Rate Limiting binding accepts besides 10s, and
 * the one `BINDING_PERIOD_SECONDS` in src/middleware/rateLimit.ts uses. Written
 * as a literal rather than imported (it is not exported anyway): this file has
 * to stay an independent oracle for what the deployed config must say, not a
 * mirror of it.
 */
const EXPECTED_PERIOD_SECONDS = 60;

/**
 * Every name in the `RateLimitBindingName` union, as an exhaustive `Record` so
 * a FIFTH member added in src/utils/env.ts is a compile error here until it is
 * listed — and then a red test until wrangler.toml declares its block. The
 * reverse drift (a toml block the union does not name) fails the same
 * assertion from the other side.
 */
const EXPECTED_BINDING_NAMES = Object.keys({
  RATE_LIMIT_60_PER_MIN: true,
  RATE_LIMIT_30_PER_MIN: true,
  RATE_LIMIT_10_PER_MIN: true,
  RATE_LIMIT_3_PER_MIN: true,
} satisfies Record<RateLimitBindingName, true>) as RateLimitBindingName[];

/** A binding's limit is encoded in its own name — the second oracle. */
const NAME_RE = /^RATE_LIMIT_(\d+)_PER_MIN$/;

// ===========================================================================
// The minimal TOML reader (see PARSING above)
// ===========================================================================

/** One `[[array.of.tables]]` block, before any shape is required of it. */
interface RawBlock {
  /** Dotted header path, e.g. `env.production.ratelimits`. */
  header: string;
  /** 1-based line of the header, so a failure names the offending block. */
  line: number;
  /** Raw (unquoted, un-parsed) right-hand sides, keyed by field name. */
  fields: Map<string, string>;
}

/** One rate limiting binding block, in the shape the assertions need. */
interface RateLimitBindingBlock {
  name: string;
  namespaceId: string;
  limit: number;
  period: number;
  line: number;
}

/**
 * Drop a trailing `# ...` comment.
 *
 * Quote-aware only as far as this file needs: a `#` inside a string value is
 * left alone, escaped quotes are not handled (none exist here, and one would
 * surface as a throw from {@link stringField}, not as a silent misread).
 */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inString = !inString;
    else if (line[i] === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

const ARRAY_HEADER_RE = /^\[\[([^\]]+)\]\]$/;
const TABLE_HEADER_RE = /^\[([^\]]+)\]$/;
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;

/** Collect every `[[array.of.tables]]` block, in file order. */
function readArrayOfTables(toml: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (line === "") continue;

    const arrayHeader = ARRAY_HEADER_RE.exec(line);
    if (arrayHeader) {
      current = {
        header: arrayHeader[1].trim(),
        line: i + 1,
        fields: new Map(),
      };
      blocks.push(current);
      continue;
    }
    // A plain table header ends whatever block preceded it.
    if (TABLE_HEADER_RE.test(line)) {
      current = null;
      continue;
    }

    const field = FIELD_RE.exec(line);
    if (field && current) current.fields.set(field[1], field[2].trim());
  }

  return blocks;
}

const QUOTED_RE = /^"([^"]*)"$/;
const SIMPLE_RE = /^\{\s*limit\s*=\s*(\d+)\s*,\s*period\s*=\s*(\d+)\s*\}$/;

/** A quoted string field, or null when absent / not a plain quoted string. */
function stringField(block: RawBlock, key: string): string | null {
  const raw = block.fields.get(key);
  if (raw === undefined) return null;
  return QUOTED_RE.exec(raw)?.[1] ?? null;
}

/** Same, but a missing / malformed field is a loud failure of this guard. */
function requireStringField(block: RawBlock, key: string): string {
  const value = stringField(block, key);
  if (value === null) {
    throw new Error(
      `wrangler.toml:${block.line} [[${block.header}]] — expected ${key} = "..." , got ${block.fields.get(key) ?? "(missing)"}`,
    );
  }
  return value;
}

const ALL_BLOCKS = readArrayOfTables(readFileSync(WRANGLER_TOML_PATH, "utf8"));

/**
 * The rate limiting binding blocks declared under one header path. A
 * `[[ratelimits]]` block carries no `type` field — the header alone is the
 * discriminator, so every block under it must have the binding shape.
 */
function rateLimitBindingBlocks(header: string): RateLimitBindingBlock[] {
  return ALL_BLOCKS.filter((block) => block.header === header).map((block) => {
    const simple = SIMPLE_RE.exec(block.fields.get("simple") ?? "");
    if (!simple) {
      throw new Error(
        `wrangler.toml:${block.line} [[${block.header}]] — expected simple = { limit = N, period = N }, got ${block.fields.get("simple") ?? "(missing)"}`,
      );
    }
    return {
      name: requireStringField(block, "name"),
      namespaceId: requireStringField(block, "namespace_id"),
      limit: Number(simple[1]),
      period: Number(simple[2]),
      line: block.line,
    };
  });
}

const DEV_BINDINGS = rateLimitBindingBlocks("ratelimits");
const PRODUCTION_BINDINGS = rateLimitBindingBlocks("env.production.ratelimits");

/**
 * The wrangler-3 header paths the bindings USED to live under, as
 * `[[unsafe.bindings]]` + `type = "ratelimit"`. Kept only so the spelling guard
 * below can name what it forbids.
 */
const LEGACY_HEADERS = new Set([
  "unsafe.bindings",
  "env.production.unsafe.bindings",
]);

/** One block still in the wrangler-3 spelling, as the spelling guard reports it. */
interface LegacyRateLimitBlock {
  header: string;
  name: string;
  line: number;
}

/**
 * The selector the spelling guard negates: every block under a legacy header
 * that declares `type = "ratelimit"`. Shared by the negative guard (over the
 * real file) and its positive companion (over a fixture) so both pin the SAME
 * predicate — a drift here is caught by the companion, not hidden by it.
 */
function legacyRateLimitBlocks(blocks: RawBlock[]): LegacyRateLimitBlock[] {
  return blocks
    .filter(
      (block) =>
        LEGACY_HEADERS.has(block.header) &&
        stringField(block, "type") === "ratelimit",
    )
    .map((block) => ({
      header: block.header,
      name: stringField(block, "name") ?? "(unnamed)",
      line: block.line,
    }));
}

const BINDING_SETS = [
  { label: "dev (top level)", blocks: DEV_BINDINGS },
  { label: "production ([env.production])", blocks: PRODUCTION_BINDINGS },
];

// ===========================================================================
// The assertions
// ===========================================================================

describe.each(BINDING_SETS)(
  "wrangler.toml rate limiting bindings — $label",
  ({ blocks }) => {
    const byName = new Map(blocks.map((block) => [block.name, block]));

    it("declares exactly the four bindings src/utils/env.ts names", () => {
      // Sorted: block ORDER in the file is not load-bearing, membership is.
      expect(blocks.map((block) => block.name).sort()).toEqual(
        [...EXPECTED_BINDING_NAMES].sort(),
      );
    });

    it.each(EXPECTED_BINDING_NAMES)(
      "configures %s with the limit its name encodes, over a 60s period",
      (name) => {
        const block = byName.get(name);
        expect(block, `no ratelimit block named ${name}`).toBeDefined();

        const encoded = NAME_RE.exec(name);
        expect(encoded, `${name} does not encode a limit`).not.toBeNull();

        expect(block!.limit).toBe(Number(encoded![1]));
        expect(block!.period).toBe(EXPECTED_PERIOD_SECONDS);
      },
    );

    it.each(EXPECTED_BINDING_NAMES)(
      "routes a check at %s's configured limit to that binding",
      (name) => {
        const block = byName.get(name);
        expect(block, `no ratelimit block named ${name}`).toBeDefined();

        // Stands in for the platform binding: `bindingForWindow` only resolves
        // it by name, never calls it.
        const stub: RateLimit = { limit: async () => ({ success: true }) };
        const env: Env = { KV: createMockKV(), ...{ [name]: stub } };

        // (max, window) come from wrangler.toml, so this goes red as soon as
        // the SHIPPED number stops being the one BINDING_BY_LIMIT maps to this
        // name — the mismatch no runtime check can see.
        expect(bindingForWindow(env, block!.limit, block!.period)).toBe(stub);
      },
    );

    it("gives each binding its own positive-integer namespace_id", () => {
      for (const block of blocks) {
        expect(
          block.namespaceId,
          `${block.name} namespace_id (wrangler.toml:${block.line})`,
        ).toMatch(/^[1-9][0-9]*$/);
      }

      const owners = new Map<string, string[]>();
      for (const block of blocks) {
        owners.set(block.namespaceId, [
          ...(owners.get(block.namespaceId) ?? []),
          block.name,
        ]);
      }
      const shared = [...owners.entries()].filter(
        ([, names]) => names.length > 1,
      );
      // Two bindings on one namespace_id count into the same platform counter,
      // so the tighter tier would be spent by the looser one's traffic.
      expect(shared).toEqual([]);
    });
  },
);

describe("wrangler.toml rate limiting bindings — dev vs production", () => {
  it("keeps the two namespace_id ranges disjoint", () => {
    const devIds = new Set(DEV_BINDINGS.map((block) => block.namespaceId));
    const collisions = PRODUCTION_BINDINGS.filter((block) =>
      devIds.has(block.namespaceId),
    ).map(
      (block) =>
        `${block.name}=${block.namespaceId} (wrangler.toml:${block.line})`,
    );

    // A shared namespace_id lets dev traffic spend production's budget.
    expect(collisions).toEqual([]);
  });
});

describe("wrangler.toml rate limiting bindings — spelling", () => {
  it("leaves no binding in the wrangler-3 [[unsafe.bindings]] form", () => {
    // wrangler 4 still ACCEPTS `[[unsafe.bindings]]` + `type = "ratelimit"`, so
    // a stale block surviving next to the `[[ratelimits]]` ones would declare
    // the same binding name twice and break the deploy — or, if only one set
    // were reverted, leave dev and production on different spellings.
    const legacy = legacyRateLimitBlocks(ALL_BLOCKS).map(
      (block) =>
        `[[${block.header}]] ${block.name} (wrangler.toml:${block.line})`,
    );

    expect(legacy).toEqual([]);
  });

  it("still recognises the wrangler-3 form when it is present", () => {
    // Positive companion of the guard above. "Zero legacy blocks" is vacuous
    // if the reader (headers, comment stripping, `type` field) drifts so it no
    // longer recognises one — this fixture proves the shared selector fires.
    const fixture = `
# 3/min — legacy spelling
[[unsafe.bindings]]
name = "RATE_LIMIT_3_PER_MIN"
type = "ratelimit" # trailing comment must not hide the discriminator
namespace_id = "1004"
simple = { limit = 3, period = 60 }

[[env.production.unsafe.bindings]]
name = "RATE_LIMIT_3_PER_MIN"
type = "ratelimit"
namespace_id = "2004"
simple = { limit = 3, period = 60 }

[[ratelimits]]
name = "RATE_LIMIT_3_PER_MIN"
namespace_id = "1004"
simple = { limit = 3, period = 60 }
`;

    const legacy = legacyRateLimitBlocks(readArrayOfTables(fixture)).map(
      ({ header, name }) => ({ header, name }),
    );

    expect(legacy).toEqual([
      { header: "unsafe.bindings", name: "RATE_LIMIT_3_PER_MIN" },
      {
        header: "env.production.unsafe.bindings",
        name: "RATE_LIMIT_3_PER_MIN",
      },
    ]);
  });
});
