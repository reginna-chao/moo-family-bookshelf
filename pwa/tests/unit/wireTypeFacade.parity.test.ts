import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * The wire types both apps must agree on live ONCE, in
 * `shared/src/api/types.ts`; `extension/src/api/types.ts`,
 * `extension/src/api/client.ts` and `pwa/src/api/client.ts` are façades that
 * only re-export them. Nothing used to enforce that: the Extension kept its
 * own `FamilyBookshelf` for months with no `familyId` and no per-member
 * `lastUpdated`, so the update tracker was fed a synthesized `null` and an
 * existing member's newly shared books never earned a 「更新」 chip (issue
 * #169). A local re-declaration on either side compiles, passes every test and
 * only diverges from the Worker's real payload at runtime. Issue #183 then
 * moved the remaining per-app duplicates the same way — the
 * `/api/user/:id/books`, `/api/version` and `/api/verify/*` shapes plus the
 * member-settings, un-kick and public-shelf ones — so the list below grew
 * with them.
 *
 * This guard reads the façades off disk and fails on any local declaration of
 * a consolidated name. Same CI rationale as
 * useSyncCodeHostVerdict.parity.test.ts: extension-check and pwa-check run on
 * disjoint path filters (`extension/**`+`shared/**` vs `pwa/**`+`shared/**`),
 * so the file is duplicated into BOTH suites and the last case holds the two
 * copies byte-identical — edit both or neither.
 */

const REPO_ROOT = resolve(__dirname, "../../..");

const SHARED_TYPES_MODULE = "moo-family-bookshelf-shared/api/types";

/** Every name that graduated into `shared/src/api/types.ts`. */
const CONSOLIDATED_NAMES = [
  "BoolFlag",
  "ApiErrorPayload",
  "ApiResponse",
  "FamilyMember",
  "FamilyGroup",
  "BookEntry",
  "FamilyBookshelfMember",
  "FamilyBookshelf",
  "LookupResult",
  "ApiError",
  // Issue #183 — personal books, version, verify, member settings, un-kick,
  // public shelf.
  "PersonalBooks",
  "PERSONAL_BOOKS_SCHEMA_VERSION",
  "VersionInfo",
  "VerifyMethod",
  "VerifyInfo",
  "SetVerifyBody",
  "OtpInfo",
  "MemberSettingsPayload",
  "UnkickResult",
  "SelectionMode",
  "PublicShelf",
  "PublicShelfData",
] as const;

interface Facade {
  path: string;
  /** The module the façade must visibly re-export from. */
  reExportsFrom: string;
}

const FACADES: Facade[] = [
  { path: "extension/src/api/types.ts", reExportsFrom: SHARED_TYPES_MODULE },
  // The Extension client re-exports through its own types façade, not from
  // shared/ directly — so `./types` is the specifier that proves the chain.
  { path: "extension/src/api/client.ts", reExportsFrom: "./types" },
  { path: "pwa/src/api/client.ts", reExportsFrom: SHARED_TYPES_MODULE },
];

const THIS_TEST_TWINS = {
  extension: "extension/tests/unit/wireTypeFacade.parity.test.ts",
  pwa: "pwa/tests/unit/wireTypeFacade.parity.test.ts",
};

/**
 * A declaration (exported or not) of one of the consolidated names — a type
 * form (`interface` / `type` / `class` / `enum`) or, since the list carries
 * `PERSONAL_BOOKS_SCHEMA_VERSION`, a value form (`const` / `let` / `var` /
 * `function`). A re-export line (`export type { FamilyBookshelf }`,
 * `export { PERSONAL_BOOKS_SCHEMA_VERSION } from`) does not match: the
 * keyword is followed by `{`, not a name.
 */
function localDeclarationOf(name: string): RegExp {
  return new RegExp(
    `^(?:export )?(?:declare )?(?:abstract )?(?:interface|type|class|enum|const|let|var|function) ${name}\\b`,
    "m",
  );
}

function readRepoFile(repoRelativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, repoRelativePath), "utf-8");
}

describe("wire-type façades", () => {
  it("still finds every consolidated name declared in shared/", () => {
    // Positive anchor: the negative checks below would pass vacuously if a
    // name had simply been deleted everywhere.
    const shared = readRepoFile("shared/src/api/types.ts");
    for (const name of CONSOLIDATED_NAMES) {
      expect(shared, `${name} is no longer declared in shared/`).toMatch(
        localDeclarationOf(name),
      );
    }
  });

  it.each(FACADES)(
    "$path only re-exports the consolidated names",
    ({ path, reExportsFrom }) => {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} is missing`).toBe(
        true,
      );
      const source = readRepoFile(path);

      // Positive companion: a façade that stopped re-exporting would also have
      // no local declaration, so pin the chain it must go through.
      expect(source).toContain(`from "${reExportsFrom}"`);

      for (const name of CONSOLIDATED_NAMES) {
        expect(
          source,
          `${path} declares its own ${name}; the Extension and the PWA would describe the same payload differently again (issue #169). Import it from ${SHARED_TYPES_MODULE} instead.`,
        ).not.toMatch(localDeclarationOf(name));
      }
    },
  );

  it("matches a local declaration but not a re-export", () => {
    // The regex is the whole guard, so pin what it does and does not see.
    const re = localDeclarationOf("FamilyBookshelf");
    expect("export interface FamilyBookshelf {").toMatch(re);
    expect("interface FamilyBookshelf {").toMatch(re);
    expect("export class ApiError extends Error {").toMatch(
      localDeclarationOf("ApiError"),
    );
    expect("export type FamilyBookshelf = {").toMatch(re);
    // Value form: the list holds a `const` since issue #183.
    const constRe = localDeclarationOf("PERSONAL_BOOKS_SCHEMA_VERSION");
    expect("export const PERSONAL_BOOKS_SCHEMA_VERSION = 1;").toMatch(constRe);
    expect("const PERSONAL_BOOKS_SCHEMA_VERSION = 1;").toMatch(constRe);
    // Word boundary: a differently named type is not the consolidated one.
    expect("export interface FamilyBookshelfMember {").not.toMatch(re);
    // Re-exports are what the façades are FOR — type and value alike, in
    // both the multi-line and single-line forms the façades actually use.
    expect('export type {\n  FamilyBookshelf,\n} from "x";').not.toMatch(re);
    expect(
      'export {\n  PERSONAL_BOOKS_SCHEMA_VERSION,\n} from "x";',
    ).not.toMatch(constRe);
    expect('export { PERSONAL_BOOKS_SCHEMA_VERSION } from "x";').not.toMatch(
      constRe,
    );
  });

  it("keeps the two copies of this guard byte-identical", () => {
    // Each suite runs only its own copy, so a copy left un-updated guards one
    // app only. No normalisation: the files sit at the same depth and every
    // path above is repo-relative, so they can be literally the same bytes.
    expect(readRepoFile(THIS_TEST_TWINS.pwa)).toBe(
      readRepoFile(THIS_TEST_TWINS.extension),
    );
  });
});
