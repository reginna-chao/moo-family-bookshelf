/**
 * The route → KV boundary, read straight off the SOURCE FILES (#163 Wave 3).
 *
 * WHY A TEST READS SOURCE. Two layering properties of `src/routes/**` are not
 * observable at runtime — a handler that reaches into KV directly behaves
 * exactly like one that goes through `src/kv/*`, and every behavioural suite
 * stays green either way:
 *
 *   (i) NO DIRECT KV ACCESS. `worker/eslint.config.js` enforces most of this,
 *       but its four `no-restricted-syntax` selectors are STATIC syntactic
 *       forms, blind to the file-local-helper shape the refactor found eight
 *       times — `async function readX(kv: KVNamespace) { kv.get(...) }`, where
 *       the binding arrives as a parameter and the selectors see nothing. The
 *       `kvKeys` import ban does not close that door either: such a helper can
 *       hand-write its key (`kv.put("family:" + id, ...)`) and import nothing
 *       at all. THIS grep is the only mechanism pinning that form — it matches
 *       the call itself, so neither a dropped lint rule nor an
 *       `// eslint-disable` can hide it. (Same split as the "DIVISION OF
 *       LABOUR" comment in `worker/eslint.config.js`.)
 *
 *   (ii) PUBLIC SHELVES STAY SINGLE-WRITER. `publicshelves:{userId}` has one
 *        writer domain — the four write handlers in `routes/publicShelf.ts`.
 *        Before this refactor that was guaranteed by construction (nothing
 *        outside the module offered a put). Now `putPublicShelves` is an
 *        exported accessor any module could import, and the books /
 *        family-prefs hot paths — which legitimately READ the key — sit one
 *        auto-import away from writing it. A stale-read books save that wrote
 *        this key would roll a revoked share token back to life and re-publish
 *        a snapshot the owner had just deleted (a P0 privacy regression that
 *        NO behavioural test would catch, because it only manifests under a
 *        ~60s cross-colo read lag).
 *
 *        "IMPORTS IT" IS SPELLING-INDEPENDENT. A named specifier list is only
 *        one way in: `import * as dal from "../kv/publicShelves"` hands a
 *        module the very same put as `dal.putPublicShelves`, and NOTHING in
 *        the toolchain catches that — the ESLint selectors see a plain
 *        identifier argument, the `no-restricted-imports` override does not
 *        name this module, and a specifier-list regex finds no `{ … }` to
 *        match. So a WILDCARD binding of the module counts as an import of
 *        the put outright, whether or not `.putPublicShelves` is ever spelled
 *        out — including the re-export forms (`export * from`,
 *        `export * as x from`), which republish the put under a new path
 *        where a specifier-list match would name an innocent-looking module.
 *
 * HOW IT AVOIDS PASSING VACUOUSLY. Every negative assertion ("zero matches")
 * is paired with a positive companion that drives the SAME detector over an
 * inline fixture containing the forbidden form — so a regex typo, a renamed
 * accessor or an empty scan list fails instead of quietly proving nothing. The
 * scanned roots additionally assert that the expected modules were actually
 * found.
 *
 * The two scan roots are overridable via env vars purely so the guards can be
 * driven RED against a throwaway copy of `src/` at authoring time (the
 * mutation check `.claude/rules/test.md` requires) without ever touching a
 * production file. CI sets neither, and the "expected modules were found"
 * assertions mean a stray value cannot silently redirect the scan to nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as familiesDal from "../../src/kv/families";
import * as usersDal from "../../src/kv/users";
import * as publicShelvesDal from "../../src/kv/publicShelves";
import * as verifyDal from "../../src/kv/verify";
import { writeBorrowPointer } from "../../src/services/borrowIndex";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `worker/src/routes` — the scope the ESLint override and this grep share. */
const ROUTES_DIR =
  process.env.MOO_KV_SCAN_ROUTES_DIR ?? resolve(HERE, "../../src/routes");

/** `worker/src` — the single-writer scan looks at EVERY module, not just routes. */
const SRC_DIR = process.env.MOO_KV_SCAN_SRC_DIR ?? resolve(HERE, "../../src");

// ===========================================================================
// A minimal source scanner
// ===========================================================================

interface ScannedFile {
  /** Path relative to the scan root, POSIX separators, e.g. `routes/user.ts`. */
  path: string;
  source: string;
}

/** Every `.ts` file under `root`, recursively, in directory order. */
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
const SRC_FILES = scanTypeScript(SRC_DIR);

/** 1-based line number of a match offset, so a failure names the exact spot. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

// ===========================================================================
// (i) No direct KV access from a route module
// ===========================================================================

interface ForbiddenForm {
  rule: string;
  re: RegExp;
}

/**
 * Matches an import (or a re-export) whose named specifier list contains
 * `name`. Written against the statement rather than the bare identifier so a
 * doc comment mentioning the symbol is not a false positive; `[^}]*` spans
 * newlines, so a multi-line specifier list is covered.
 */
function specifierRe(name: string): RegExp {
  return new RegExp(
    `(?:import|export)\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`,
    "g",
  );
}

const FORBIDDEN_IN_ROUTES: ForbiddenForm[] = [
  {
    // The form the ESLint selectors DO cover — pinned here too, so removing
    // the lint rule is not enough to make the violation invisible.
    rule: "direct binding call (c.env.KV.*)",
    re: /c\.env\.KV\./g,
  },
  {
    // The form the ESLint selectors CANNOT see: the binding arrives as a
    // `kv: KVNamespace` parameter of a file-local helper, so the callee's
    // object is a plain identifier, not `X.KV`.
    rule: "file-local KV helper call (kv.get/put/delete/list)",
    re: /\bkv\.(?:get|put|delete|list)\(/g,
  },
  {
    // Routes never build a key. ESLint bans the import; pinning it here from
    // the source side means an `// eslint-disable` cannot hide it.
    rule: "kvKeys import",
    re: specifierRe("kvKeys"),
  },
];

interface Violation {
  rule: string;
  where: string;
  text: string;
}

function findForbidden(
  files: ScannedFile[],
  forms: ForbiddenForm[],
): Violation[] {
  const found: Violation[] = [];
  for (const file of files) {
    for (const form of forms) {
      for (const match of file.source.matchAll(form.re)) {
        found.push({
          rule: form.rule,
          where: `${file.path}:${lineOf(file.source, match.index)}`,
          text: match[0].trim(),
        });
      }
    }
  }
  return found;
}

/**
 * One inline module carrying exactly one instance of each forbidden form — the
 * positive companion for every "zero matches" assertion below. Kept as a
 * STRING: nothing is written to disk and nothing under `src/` is touched.
 */
const VIOLATING_ROUTE_FIXTURE = `
import { kvKeys } from "../kv/schema";
import type { Env } from "../utils/env";

async function readThing(kv: KVNamespace, id: string) {
  return kv.get(\`thing:\${id}\`, "json");
}

export async function handler(c: { env: Env }) {
  await c.env.KV.put("user:x", "{}");
  return readThing(c.env.KV, "x");
}
`;

describe("src/routes/** KV access boundary", () => {
  it("scans the route modules it is supposed to scan", () => {
    // Positive companion for every "zero matches" assertion: an empty or
    // misdirected scan must not read as a clean bill of health.
    expect(ROUTE_FILES.length).toBeGreaterThan(0);
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

  it("detects every forbidden form on a fixture that contains them", () => {
    const found = findForbidden(
      [{ path: "__fixture__.ts", source: VIOLATING_ROUTE_FIXTURE }],
      FORBIDDEN_IN_ROUTES,
    );

    // Each rule fires at least once — a typo in any of the three regexes below
    // would make the real-source assertion pass vacuously.
    expect([...new Set(found.map((v) => v.rule))].sort()).toEqual(
      FORBIDDEN_IN_ROUTES.map((form) => form.rule).sort(),
    );
  });

  it.each(FORBIDDEN_IN_ROUTES)(
    "no route module contains: $rule",
    ({ rule, re }) => {
      // Re-created per case: `matchAll` on a shared /g regex is safe, but a
      // fresh instance keeps each case independent of the others' lastIndex.
      const found = findForbidden(ROUTE_FILES, [
        { rule, re: new RegExp(re.source, re.flags) },
      ]);
      expect(found).toEqual([]);
    },
  );
});

// ===========================================================================
// The data access layer's own surface
// ===========================================================================

/**
 * The EXACT export list of each DAL module, asserted with equality rather than
 * containment on purpose. A missing name breaks the routes that call it (the
 * import would not compile), but an ADDED one is the silent direction: a bare
 * `putPublicSnapshot` here would be a way around the `buildSnapshot`
 * URL-whitelist chokepoint and the dynamic-TTL rule in
 * `services/publicShelf.ts`, and nothing else would notice. Adding an accessor
 * is fine — updating this list is the deliberate act that says so.
 */
const DAL_MODULES: [string, Record<string, unknown>, string[]][] = [
  [
    "src/kv/families.ts",
    familiesDal,
    [
      "getFamilyRecord",
      "putFamilyRecord",
      "deleteFamilyRecord",
      "getMemberFamilyId",
      "putMemberFamilyId",
      "deleteMemberFamilyId",
      "hasKickedTombstone",
      "putKickedTombstone",
      "deleteKickedTombstone",
    ],
  ],
  [
    "src/kv/users.ts",
    usersDal,
    ["getUserBooksRecord", "putUserBooksRecord", "deleteUserBooksRecord"],
  ],
  [
    "src/kv/publicShelves.ts",
    publicShelvesDal,
    [
      "getPublicShelves",
      "putPublicShelves",
      "deletePublicShelves",
      "getPublicSnapshot",
      "deletePublicSnapshot",
    ],
  ],
  [
    "src/kv/verify.ts",
    verifyDal,
    [
      "getVerifyRecord",
      "putVerifyRecord",
      "putOtpRecord",
      "getQrTokenRecord",
      "putQrTokenRecord",
      "deleteQrToken",
    ],
  ],
];

describe("src/kv/* data access modules", () => {
  it.each(DAL_MODULES)(
    "%s exports exactly its accessor set",
    (_name, mod, expected) => {
      expect(Object.keys(mod).sort()).toEqual([...expected].sort());
      for (const accessor of expected) {
        expect(typeof mod[accessor]).toBe("function");
      }
    },
  );

  it("keeps the borrow pointer writer in services/borrowIndex.ts", () => {
    // It lives with the index it must be ordered against, not in src/kv/.
    expect(typeof writeBorrowPointer).toBe("function");
  });
});

// ===========================================================================
// (ii) publicshelves:{userId} stays single-writer
// ===========================================================================

/** Specifier suffix of the public-shelf DAL, as every importer spells it. */
const PUBLIC_SHELVES_MODULE = "kv/publicShelves";

/**
 * Matches a WILDCARD binding of a module whose specifier ends in `modulePath`:
 * `import * as dal from "../kv/publicShelves"`, plus the two re-export forms
 * (`export * from`, `export * as dal from`) that republish its exports under a
 * new path. `import * from` is not valid TS, so the optional `as <name>` covers
 * every real spelling of all three.
 *
 * A wildcard binding never names the accessor, so `specifierRe` cannot see it —
 * and neither can anything else in the toolchain (see the header note on (ii)).
 */
function wildcardBindingRe(modulePath: string): RegExp {
  return new RegExp(
    `(?:import|export)\\s+\\*\\s+(?:as\\s+\\w+\\s+)?from\\s+["'][^"']*${modulePath}["']`,
    "g",
  );
}

/**
 * True when `source` can reach `putPublicShelves`: it either names the accessor
 * in a specifier list (from any module, so a re-export cannot launder it), or
 * takes a wildcard binding of the DAL module — which grants the put regardless
 * of whether `.putPublicShelves` is ever written out.
 */
function canWritePublicShelves(source: string): boolean {
  return (
    specifierRe("putPublicShelves").test(source) ||
    wildcardBindingRe(PUBLIC_SHELVES_MODULE).test(source)
  );
}

/** Modules under `src/` that can reach `putPublicShelves`, by either route. */
function putImporters(files: ScannedFile[]): string[] {
  return files
    .filter((file) => canWritePublicShelves(file.source))
    .map((file) => file.path);
}

const PUBLIC_SHELF_ROUTE = "routes/publicShelf.ts";
const USER_ROUTE = "routes/user.ts";

/**
 * Detector companion for the wildcard half: every spelling that hands a module
 * the put, and the controls that must NOT fire — a read-only named import (the
 * books / family-prefs hot paths depend on staying legal) and a wildcard of a
 * DIFFERENT DAL module. Kept as STRINGS: nothing is written under `src/`.
 */
const WILDCARD_FIXTURES: [string, string, boolean][] = [
  [
    "a namespace import that calls the put",
    `import * as dal from "../kv/publicShelves";\nawait dal.putPublicShelves(c.env.KV, userId, record);`,
    true,
  ],
  [
    "a namespace import that never spells the accessor out",
    `import * as dal from "../kv/publicShelves";`,
    true,
  ],
  [
    "a re-export of the whole module",
    `export * from "../kv/publicShelves";`,
    true,
  ],
  [
    "a namespaced re-export of the whole module",
    `export * as publicShelvesDal from "../kv/publicShelves";`,
    true,
  ],
  [
    "a read-only named import (allowed)",
    `import { getPublicShelves } from "../kv/publicShelves";`,
    false,
  ],
  [
    "a wildcard binding of a different DAL module (allowed)",
    `import * as dal from "../kv/users";`,
    false,
  ],
];

describe("publicshelves:{userId} single-writer invariant", () => {
  it("scans the modules it is supposed to scan", () => {
    // Positive companion: if any of these three disappeared from the scan, the
    // importer assertions below would be measuring nothing.
    const paths = SRC_FILES.map((file) => file.path);
    expect(paths).toContain("kv/publicShelves.ts");
    expect(paths).toContain(PUBLIC_SHELF_ROUTE);
    expect(paths).toContain(USER_ROUTE);
  });

  it("finds an injected extra importer (detector companion)", () => {
    // Both ways in, driven over the REAL scan list so an empty or misdirected
    // scan cannot make the equality assertion below pass vacuously.
    const injected = putImporters([
      ...SRC_FILES,
      {
        path: "routes/__named__.ts",
        source: `import { getPublicShelves, putPublicShelves } from "../kv/publicShelves";`,
      },
      {
        path: "routes/__namespace__.ts",
        source: `import * as dal from "../kv/publicShelves";`,
      },
    ]);
    expect(injected).toContain("routes/__named__.ts");
    expect(injected).toContain("routes/__namespace__.ts");
  });

  it.each(WILDCARD_FIXTURES)(
    "classifies %s (detector companion)",
    (_label, source, expected) => {
      expect(canWritePublicShelves(source)).toBe(expected);
    },
  );

  it("is imported by routes/publicShelf.ts and by nothing else", () => {
    // Exactly one importer — asserted as equality, so the "zero" failure mode
    // (a renamed accessor the detector no longer sees) is caught too. A
    // wildcard binding of the DAL anywhere under `src/` lands here as well.
    expect(putImporters(SRC_FILES)).toEqual([PUBLIC_SHELF_ROUTE]);
  });

  it("is called from exactly one site inside routes/publicShelf.ts", () => {
    const module = SRC_FILES.find((file) => file.path === PUBLIC_SHELF_ROUTE);
    expect(module).toBeDefined();

    // The local `writePublicShelves` wrapper. `(` excludes the import
    // specifier and the JSDoc mentions of the same name.
    const calls = [...module!.source.matchAll(/\bputPublicShelves\(/g)];
    expect(calls).toHaveLength(1);
  });

  it("lets routes/user.ts DELETE the pointer list but never write it", () => {
    const module = SRC_FILES.find((file) => file.path === USER_ROUTE);
    expect(module).toBeDefined();

    // The whole-account teardown is a wipe, not a list write — it can
    // resurrect nothing, so it is the one sanctioned non-publicShelf toucher.
    // The negative half runs the full detector: a namespace import here would
    // hand the books hot path the put without ever naming it.
    expect(specifierRe("deletePublicShelves").test(module!.source)).toBe(true);
    expect(canWritePublicShelves(module!.source)).toBe(false);
  });
});
