/**
 * `AGENTS.md` → `## API Endpoints` vs. the routes the Worker registers (tripwire).
 *
 * WHY. The coder / reviewer / security-auditor agents work from the API table
 * in the repo-root `AGENTS.md` when they reason about which endpoints exist,
 * who may call them and what a change touches. Nothing tied that table to the
 * code: before #354 it listed 10 of the 37 routes the Worker registers, so an
 * agent auditing "every write path" silently skipped three quarters of them,
 * and every check in CI stayed green.
 *
 * WHAT IT PINS. Set equality, row by row: every `| \`METHOD\` | \`/path\` | … |`
 * row inside the `## API Endpoints` section (all of its `### ` sub-sections,
 * up to the next `## ` heading) must name a route in the production `app`'s
 * `app.routes`, and every registered route must have a row. `method === "ALL"`
 * entries are middleware (`app.use`) and are not routes. Descriptions are not
 * compared — only the method + path key. A duplicated row is red too, as is an
 * empty parse (a renamed heading or a reshaped row would otherwise make the
 * table vanish and the comparison vacuous).
 *
 * MODULE ISOLATION. `app.routes` is read off the SAME production `app` object
 * that `tests/integration/appOnError.test.ts` mounts its probe sub-app onto
 * (`app.route("/api/__probe", probe)`). That mount stays out of this file only
 * because vitest isolates the module registry per test file (the default
 * `isolate: true`; `worker/vitest.config.ts` does not change it). If isolation
 * were ever turned off, this test would go red with a message like
 * "missing (registered, no row): POST /api/__probe/json, …" — a test-runner
 * change, not doc drift.
 *
 * CI REACHABILITY (.claude/rules/test.md → "Cross-package parity tests must be
 * CI-reachable"): this guard lives in `worker-check`. A route change reaches it
 * through the `worker` path filter in `.github/workflows/cicd.yml`; an
 * `AGENTS.md`-only edit reaches it through the `workflows` filter, which lists
 * `AGENTS.md` and feeds `worker-check`'s `if:`. It is deliberately NOT in the
 * `worker` filter: that output also gates deploy-worker-dev and the E2E jobs,
 * and a docs-only push must not redeploy an unchanged Worker. Dropping
 * `AGENTS.md` from the `workflows` filter silently blinds this guard on the
 * very change class (a table edit) it exists to catch.
 *
 * PROVEN ABLE TO FAIL (test.md → "Guard tests must prove they can fail") by the
 * fixture cases below, which drive `parseApiEndpointTable` + `diffRoutes` against an inline
 * markdown string — a missing registered route lands in `missing`, a fake row
 * lands in `extra` — without ever editing the real `AGENTS.md`. MUTATION-CHECKED
 * at authoring time too: a throwaway copy of this file, pointed at a scratch
 * `AGENTS.md` with the `POST /api/auth/refresh` row removed and a
 * `POST /api/nope` row added, and mounting one extra `GET` route on its own
 * `app`, went RED listing both missing routes and the extra row separately.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import app from "../../src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS_MD = resolve(HERE, "../../../AGENTS.md");

const SECTION_HEADING = "## API Endpoints";

/** `| \`GET\` | \`/api/x/:id\` | …` — METHOD and path captured; path may be `/`. */
const TABLE_ROW_PATTERN =
  /^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`(\/[^`]*)`\s*\|/;

/** The minimal `RouterRoute` shape this guard reads. */
type RouteTable = { routes: readonly { method: string; path: string }[] };

/** `"METHOD path"` rows of the `## API Endpoints` section, in document order. */
function parseApiEndpointTable(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = TABLE_ROW_PATTERN.exec(line.trim());
    if (match) rows.push(`${match[1]} ${match[2]}`);
  }
  return rows;
}

/** De-duplicated `"METHOD path"` keys of every route, middleware (`ALL`) excluded. */
function registeredRoutes(routeTable: RouteTable): Set<string> {
  return new Set(
    routeTable.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method.toUpperCase()} ${route.path}`),
  );
}

/** `missing` = registered but undocumented; `extra` = documented but unregistered. */
function diffRoutes(
  table: string[],
  registered: Set<string>,
): { missing: string[]; extra: string[] } {
  const documented = new Set(table);
  return {
    missing: [...registered].filter((key) => !documented.has(key)).sort(),
    extra: [...documented].filter((key) => !registered.has(key)).sort(),
  };
}

function duplicatesOf(rows: string[]): string[] {
  return rows.filter((row, index) => rows.indexOf(row) !== index);
}

/** A trimmed section; the row under `## Other` must be ignored by the parser. */
const FIXTURE_HEADER = [
  "# Fixture",
  "",
  "## API Endpoints",
  "",
  "Intro prose that is not a table row.",
  "",
  "### Meta",
  "",
  "| Method | Path | Description |",
  "| ------ | ---- | ----------- |",
];
const FIXTURE_FOOTER = [
  "",
  "## Other",
  "",
  "| `DELETE` | `/api/outside-the-section` | Must be ignored |",
];

function fixture(rows: string[]): string {
  return [...FIXTURE_HEADER, ...rows, ...FIXTURE_FOOTER].join("\n");
}

const FIXTURE_REGISTERED = new Set([
  "GET /",
  "GET /api/version",
  "GET /api/user/:id/books",
]);

describe("parseApiEndpointTable", () => {
  it("reads only the rows of the API Endpoints section, including the bare `/` path", () => {
    const rows = parseApiEndpointTable(
      fixture([
        "| `GET`  | `/`                   | Health check   |",
        "| `GET`  | `/api/version`        | Version        |",
        "| `GET`  | `/api/user/:id/books` | Get user books |",
      ]),
    );

    expect(rows).toEqual([
      "GET /",
      "GET /api/version",
      "GET /api/user/:id/books",
    ]);
    expect(rows).not.toContain("DELETE /api/outside-the-section");
  });

  it("returns no rows when the section heading is absent", () => {
    expect(parseApiEndpointTable("# Doc\n\n| `GET` | `/` | x |\n")).toEqual([]);
  });
});

describe("diffRoutes (fixture: proves the guard can fail)", () => {
  it("reports a registered route that has no row under `missing`", () => {
    const table = parseApiEndpointTable(
      fixture([
        "| `GET` | `/`                   | Health check   |",
        "| `GET` | `/api/user/:id/books` | Get user books |",
      ]),
    );

    expect(diffRoutes(table, FIXTURE_REGISTERED)).toEqual({
      missing: ["GET /api/version"],
      extra: [],
    });
  });

  it("reports a row for an unregistered route under `extra`", () => {
    const table = parseApiEndpointTable(
      fixture([
        "| `GET`  | `/`                   | Health check   |",
        "| `GET`  | `/api/version`        | Version        |",
        "| `GET`  | `/api/user/:id/books` | Get user books |",
        "| `POST` | `/api/nope`           | Fake row       |",
      ]),
    );

    expect(diffRoutes(table, FIXTURE_REGISTERED)).toEqual({
      missing: [],
      extra: ["POST /api/nope"],
    });
  });
});

describe("AGENTS.md API Endpoints table", () => {
  const table = parseApiEndpointTable(readFileSync(AGENTS_MD, "utf8"));
  const registered = registeredRoutes(app);

  it("parses a non-empty table with no duplicate rows", () => {
    expect(
      table.length,
      `No rows parsed under "${SECTION_HEADING}" in ${AGENTS_MD}. A renamed ` +
        `heading or reshaped row would make the comparison below vacuous.`,
    ).toBeGreaterThan(0);
    expect(duplicatesOf(table), "duplicated rows in the table").toEqual([]);
  });

  it("documents exactly the routes the Worker registers", () => {
    const { missing, extra } = diffRoutes(table, registered);

    expect(
      { missing, extra },
      `AGENTS.md → "${SECTION_HEADING}" has drifted from app.routes.\n` +
        `missing (registered, no row): ${missing.join(", ") || "none"}\n` +
        `extra (row, not registered): ${extra.join(", ") || "none"}\n` +
        `Add / remove the rows in AGENTS.md; do not weaken this check.`,
    ).toEqual({ missing: [], extra: [] });
  });
});
