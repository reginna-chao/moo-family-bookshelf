import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as workerEntry from "../../src/index";
import { AttemptBudgetObject } from "../../src/durable/attemptBudgetObject";
import type { Env } from "../../src/utils/env";

/**
 * `worker/wrangler.toml` — the `ATTEMPT_BUDGET` Durable Object this repo SHIPS.
 *
 * WHY A TEST READS A CONFIG FILE. The binding is optional in `Env`: a Worker
 * deployed without it still runs, with the verification gate's two hourly
 * budgets back on the KV counters (`ATTEMPT_BUDGET_BINDING_MISSING` in the
 * logs, a soft bound again). Environments do NOT inherit `durable_objects`, so
 * dropping the `[env.production]` copy turns production back to KV while every
 * other test stays green — they inject the namespace themselves
 * (tests/helpers/productionBindings.ts). Nothing at runtime can tell a missing
 * binding from a self-hoster who never added it. This file is where that drift
 * is caught.
 *
 * WHAT IT PINS:
 *
 * - exactly one top-level `[[durable_objects.bindings]]` and one
 *   `[[env.production.durable_objects.bindings]]`, each `name = "ATTEMPT_BUDGET"`
 *   (the `Env` field production reads) and `class_name = "AttemptBudgetObject"`;
 * - that the class name is exported by `src/index.ts`, the module wrangler
 *   deploys, as the class in `src/durable/attemptBudgetObject.ts` — a deployed
 *   class missing from a later version makes that version undeployable;
 * - exactly one top-level `[[migrations]]`, `tag = "v1"`,
 *   `new_sqlite_classes = ["AttemptBudgetObject"]` (SQLite-backed, the only
 *   kind the Free plan allows; no `new_classes`), and none under
 *   `[env.production]`: migrations are inherited, and the file says never to
 *   repeat them there.
 *
 * NOT COVERED: a self-hoster's edited copy, and whether Cloudflare applies the
 * migration. `wrangler deploy --dry-run` lists the binding (checked by hand),
 * and `scripts/test-attempt-budget-runtime.mjs` runs the class on a local
 * workerd.
 *
 * PARSING IS HAND-ROLLED, for the reason in `wranglerRateLimits.test.ts` (no TOML
 * parser in this workspace; one test does not justify a dependency). The reader
 * understands `[[array.of.tables]]` headers and `key = value` lines; values stay
 * raw TOML literals, compared as text. A block re-spelled in another valid TOML
 * form (an inline table, a dotted key) reads as absent and fails loudly.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML_PATH = resolve(HERE, "../../wrangler.toml");

/** The binding name, checked against `Env` at compile time. */
const BINDING_NAME = "ATTEMPT_BUDGET" satisfies keyof Env;
const CLASS_NAME = "AttemptBudgetObject";

const ARRAY_HEADER_RE = /^\[\[([^\]]+)\]\]$/;
const TABLE_HEADER_RE = /^\[([^\]]+)\]$/;
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;

/** One `[[array.of.tables]]` block: its dotted header and raw fields. */
interface RawBlock {
  header: string;
  fields: Record<string, string>;
}

/** Every `[[array.of.tables]]` block in file order; a `[table]` header ends the current block. */
function readArrayOfTables(toml: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (line === "") continue;
    const arrayHeader = ARRAY_HEADER_RE.exec(line);
    if (arrayHeader) {
      current = { header: arrayHeader[1].trim(), fields: {} };
      blocks.push(current);
      continue;
    }
    if (TABLE_HEADER_RE.test(line)) {
      current = null;
      continue;
    }
    const field = FIELD_RE.exec(line);
    if (field && current) current.fields[field[1]] = field[2].trim();
  }
  return blocks;
}

const BLOCKS = readArrayOfTables(readFileSync(WRANGLER_TOML_PATH, "utf8"));

function blocksUnder(header: string): Record<string, string>[] {
  return BLOCKS.filter((b) => b.header === header).map((b) => b.fields);
}

const EXPECTED_BINDING = {
  name: `"${BINDING_NAME}"`,
  class_name: `"${CLASS_NAME}"`,
};

describe.each([
  { label: "top level", header: "durable_objects.bindings" },
  {
    label: "[env.production]",
    header: "env.production.durable_objects.bindings",
  },
])("wrangler.toml Durable Object binding — $label", ({ header }) => {
  it("declares exactly the ATTEMPT_BUDGET binding to AttemptBudgetObject", () => {
    expect(blocksUnder(header)).toEqual([EXPECTED_BINDING]);
  });
});

describe("wrangler.toml Durable Object migrations", () => {
  it("creates AttemptBudgetObject as a SQLite-backed class in migration v1", () => {
    expect(blocksUnder("migrations")).toEqual([
      { tag: '"v1"', new_sqlite_classes: `["${CLASS_NAME}"]` },
    ]);
  });

  it("does not repeat the migrations under [env.production], which inherits them", () => {
    expect(blocksUnder("env.production.migrations")).toEqual([]);
  });

  it("reads the production array-of-tables at all, so the line above cannot pass on an empty parse", () => {
    expect(blocksUnder("env.production.ratelimits").length).toBeGreaterThan(0);
  });
});

describe("src/index.ts — the class the binding names", () => {
  it("exports AttemptBudgetObject under the class_name wrangler.toml uses", () => {
    expect(Object.keys(workerEntry)).toContain(CLASS_NAME);
    expect(workerEntry.AttemptBudgetObject).toBe(AttemptBudgetObject);
  });
});
