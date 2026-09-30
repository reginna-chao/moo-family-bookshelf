/**
 * Path-param validation lives ONLY in the route schemas (#227) — read straight
 * off the route SOURCE FILES.
 *
 * WHY A TEST READS SOURCE. Before #227 each handler read its path params with
 * `c.req.param(...)` and validated them itself with an `isValid*` helper. The
 * schemas (`schemas/common.ts`, tagged params) are now the single source of
 * that check, and handlers read the already-validated value through
 * `c.req.valid("param")`. A handler that goes back to `c.req.param(...)` still
 * works — the schema validated the same raw value first — so no behavioural
 * suite would notice the drift; but the second, handler-local check it invites
 * is exactly the duplicated validation #227 removed, free to disagree with the
 * schema about format or error copy.
 *
 * Two detectors:
 *   (1) NO RAW PARAM READ. `req.param(` does not appear in any route module at
 *       all. This is the load-bearing one: the pre-#227 code read the param
 *       into a local first (`const familyId = c.req.param("id"); if
 *       (!isValidFamilyId(familyId)) …`), a shape detector (2) alone would
 *       never have matched.
 *   (2) NO INLINE PARAM VALIDATION. `isValid(FamilyId|UserId|RequestId|
 *       ShareToken)(c.req.param(` — the direct form. Body-field checks such as
 *       `isValidUserId(body.userId)` are legitimate (body validation moves to
 *       the schemas separately, #239) and must NOT match.
 *
 * Every "zero matches" assertion has a positive companion: the same detector
 * driven over an inline fixture holding the forbidden form, plus a check that
 * the scan actually found the route modules.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, "../../src/routes");

interface ScannedFile {
  /** Path relative to `src/routes`, POSIX separators. */
  path: string;
  source: string;
}

function scanTypeScript(root: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      files.push({
        path: relative(root, full).split("\\").join("/"),
        source: readFileSync(full, "utf8"),
      });
    }
  };
  walk(root);
  return files;
}

const ROUTE_FILES = scanTypeScript(ROUTES_DIR);

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

interface ForbiddenForm {
  rule: string;
  re: RegExp;
}

const FORBIDDEN: ForbiddenForm[] = [
  {
    // Any context name (`c`, `ctx` …) and any argument list, including the
    // no-argument `req.param()` that returns every param at once.
    rule: "raw path-param read (req.param)",
    re: /\breq\.param\s*\(/g,
  },
  {
    rule: "inline path-param validation (isValid*(c.req.param(…)))",
    re: /\bisValid(?:FamilyId|UserId|RequestId|ShareToken)\s*\(\s*\w+\.req\.param\s*\(/g,
  },
];

function findForbidden(files: ScannedFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const form of FORBIDDEN) {
      for (const match of file.source.matchAll(form.re)) {
        found.push(
          `${form.rule} @ ${file.path}:${lineOf(file.source, match.index)}`,
        );
      }
    }
  }
  return found;
}

/** The pre-#227 handler shape, verbatim — detector (1) must catch it. */
const PRE_227_HANDLER_FIXTURE = `
bookshelfRoutes.openapi(getFamilyBookshelfRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(c, 400, "INVALID_FAMILY_ID", "Family ID format is invalid");
  }
});
`;

/** The direct inline form, one per helper — detector (2) must catch all four. */
const INLINE_CHECK_FIXTURE = `
if (!isValidFamilyId(c.req.param("id"))) return bad(c);
if (!isValidUserId(ctx.req.param("uid"))) return bad(c);
if (!isValidRequestId( c.req.param("requestId") )) return bad(c);
if (!isValidShareToken(c.req.param("shareToken"))) return bad(c);
`;

/** Legitimate code the detectors must leave alone. */
const LEGITIMATE_FIXTURE = `
const { id: familyId, uid } = c.req.valid("param");
if (!isValidUserId(body.userId)) {
  return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
}
if (typeof body.familyId !== "string" || !isValidFamilyId(body.familyId)) {}
const q = c.req.query("x");
`;

const asFile = (source: string): ScannedFile[] => [
  { path: "fixture.ts", source },
];

describe("src/routes/** path-param boundary", () => {
  it("scans the route modules it is supposed to scan", () => {
    expect(ROUTE_FILES.map((file) => file.path).sort()).toEqual([
      "auth.ts",
      "bookshelf.ts",
      "borrow.ts",
      "family.ts",
      "publicShelf.ts",
      "user.ts",
      "verify.ts",
    ]);
  });

  it("finds the schema-validated read in every module that has path params", () => {
    const readers = ROUTE_FILES.filter((file) =>
      file.source.includes('c.req.valid("param")'),
    ).map((file) => file.path);

    // auth.ts has no path params; the other six all read through the schema.
    expect(readers.sort()).toEqual([
      "bookshelf.ts",
      "borrow.ts",
      "family.ts",
      "publicShelf.ts",
      "user.ts",
      "verify.ts",
    ]);
  });

  it("catches the pre-#227 read-then-check handler shape", () => {
    expect(findForbidden(asFile(PRE_227_HANDLER_FIXTURE))).toEqual([
      "raw path-param read (req.param) @ fixture.ts:3",
    ]);
  });

  it("catches every inline isValid*(c.req.param(…)) form", () => {
    const found = findForbidden(asFile(INLINE_CHECK_FIXTURE));

    expect(
      found.filter((v) => v.startsWith("inline path-param validation")),
    ).toHaveLength(4);
    // Each of those also reads the raw param, so detector (1) fires too.
    expect(
      found.filter((v) => v.startsWith("raw path-param read")),
    ).toHaveLength(4);
  });

  it("leaves body-field checks and schema-validated reads alone", () => {
    expect(findForbidden(asFile(LEGITIMATE_FIXTURE))).toEqual([]);
  });

  it("no route module reads or validates a path param outside the schemas", () => {
    expect(findForbidden(ROUTE_FILES)).toEqual([]);
  });
});
