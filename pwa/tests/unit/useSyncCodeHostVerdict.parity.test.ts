import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * The Extension and the PWA each carry their OWN copy of the sync-code `@host`
 * verdict hook. Only the display POLICY is shared (`displayedSyncCodeApiHost`
 * and `SYNC_CODE_HOST_SETTLE_DELAY_MS` in `shared/api/syncCodeHost`); the settle
 * TRIGGERS — the restarting timer, the paste flag, the never-typed prefill —
 * live entirely in the twins, and they are exactly the part a change to this
 * behaviour touches. Until now nothing but a header comment pointed each twin at
 * the other, so one side could gain a trigger the other lacks and both suites
 * would stay green while the two apps disagreed about when a spoofed endpoint
 * gets called out.
 *
 * This test reads the files off disk and compares them after normalising the
 * differences that are structural rather than behavioural.
 *
 * A row leaves this table when its subject stops being a pair: the two
 * API-boundary validators that used to sit here graduated into `shared/`
 * (`shared/src/api/memberValidation.ts` and `shared/src/borrow/validation.ts`),
 * which is exactly the repair path the first row's stake describes.
 *
 * This file is itself duplicated into BOTH suites — see
 * extension/tests/unit/useSyncCodeHostVerdict.parity.test.ts and
 * pwa/tests/unit/useSyncCodeHostVerdict.parity.test.ts. A single copy would be
 * cheaper to maintain but would not RUN: .github/workflows/cicd.yml gates
 * extension-check on the `extension` path filter (extension and shared) and
 * pwa-check on the `pwa` one (pwa and shared), so a PR that touches only the
 * PWA twin would never execute an Extension-side comparison — the drift would
 * land on main and detonate later, on an unrelated PR that happens to touch the
 * Extension. That is worse than having no test, because the file advertises a
 * guarantee it delivers in one direction only. With a copy in each suite EITHER
 * path filter is sufficient, and a shared change runs both. (Widening the
 * `extension` filter to cover the PWA was rejected: it drags the whole Extension
 * suite into every PWA PR, and it breaks again, silently, the next time a twin
 * pair is added.)
 *
 * The two copies are therefore a twin pair in their own right, held together by
 * the last row of the table below — edit both or neither. They sit at the same
 * depth (<app>/tests/unit/), which is what lets them be literally identical
 * rather than merely equivalent: every path below is repo-relative, and
 * REPO_ROOT resolves the same way from either copy.
 */

const REPO_ROOT = resolve(__dirname, "../../..");

interface TwinPair {
  /** Human-readable subject, used in the test name. */
  what: string;
  extension: string;
  pwa: string;
  /** A line that must survive normalisation, guarding a vacuous pass. */
  marker: string;
  /** What drift costs here, and how to repair it — shown when a compare fails. */
  stake: string;
}

const TWINS: TwinPair[] = [
  {
    what: "the sync-code @host verdict hook",
    extension: "extension/src/dialog/useSyncCodeHostVerdict.ts",
    pwa: "pwa/src/hooks/useSyncCodeHostVerdict.ts",
    marker: "export function useSyncCodeHostVerdict(",
    stake:
      "These two files are deliberate twins: only the display policy lives in shared/, so a settle trigger added, removed or retimed on one side silently changes when the PWA and the Extension warn about a spoofed @host. Fix it by applying the same edit to both files — or, if the new logic has no app-specific dependency, move it into shared/src/api/syncCodeHost.ts and delete it from both twins.",
  },
  {
    what: "the sync-code @host test fixtures",
    extension: "extension/tests/helpers/syncCodeHostFixtures.ts",
    pwa: "pwa/tests/helpers/syncCodeHostFixtures.ts",
    marker: "export const HALF_TYPED_PREFIXES",
    stake:
      "These constants had already drifted once — HALF_TYPED_PREFIXES existed in three different lengths — which left the two apps proving different things about the same security-facing warning. Apply the same edit to both files.",
  },
  {
    what: "this cross-app comparison itself",
    extension: "extension/tests/unit/useSyncCodeHostVerdict.parity.test.ts",
    pwa: "pwa/tests/unit/useSyncCodeHostVerdict.parity.test.ts",
    // This pair has no permitted difference at all. The marker also appears as
    // data in this very row, which still proves normalisation left the file
    // standing; the row's real anchor is the comparison below.
    marker: "function normalize(source: string): string {",
    stake:
      "Each suite runs only its own copy — that is the whole point of duplicating this file — so a copy left un-updated does not run for that app's PRs, and the guarantee holds in one direction only. Apply the same edit to both copies.",
  },
];

/** Placeholder left where a known-divergent fragment used to be. */
const TWIN_DIR = "<twin-dir>";
const CRYPTO_MODULE = "<crypto/syncCode>";

/**
 * Erase the three differences the twins are ALLOWED to have, and nothing else:
 *
 *   1. the directory each app keeps its own module in — the FILE NAME after it
 *      is left intact, so a rename on one side still fails this test;
 *   2. how each app resolves its crypto module (`../` vs the `@/` alias);
 *   3. line wrapping — JSDoc leaders and whitespace runs collapse, so prose
 *      re-flowed to fit 80 columns is not mistaken for a behaviour change.
 *
 * A JSDoc leader is a `*` followed by whitespace or by end of line, and nothing
 * else: Prettier also prints a generator method with `*` at line start
 * (`*next()`), and eating that would let real code compare equal to code that
 * lacks it.
 */
function normalize(source: string): string {
  return source
    .replace(
      /extension\/src\/dialog|pwa\/src\/hooks|(?:extension|pwa)\/tests\/helpers/g,
      TWIN_DIR,
    )
    .replace(/(["'])(?:\.\.|@)\/crypto\/syncCode\1/g, `"${CRYPTO_MODULE}"`)
    .replace(/^[ \t]*\*(?:[ \t]|$)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readTwin(repoRelativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, repoRelativePath), "utf-8");
}

describe("Extension / PWA twin modules", () => {
  it.each(TWINS)(
    "keeps $what identical in both apps",
    ({ what, extension, pwa, marker, stake }) => {
      const extensionSource = normalize(readTwin(extension));
      const pwaSource = normalize(readTwin(pwa));

      // Guard against a vacuous pass: normalisation must leave the real content
      // behind, and each twin must name the other app's copy.
      for (const source of [extensionSource, pwaSource]) {
        expect(source).toContain(marker);
      }

      const namesTheOtherDir = `${what}: each twin must name the other app's directory, so a reader landing on either copy is told there is a second one.`;
      for (const source of [extensionSource, pwaSource]) {
        expect(source, namesTheOtherDir).toContain(TWIN_DIR);
      }

      expect(pwaSource, `${pwa} has drifted from ${extension}. ${stake}`).toBe(
        extensionSource,
      );
    },
  );

  it("normalizes away the import specifier without hiding a real rename", () => {
    // The normaliser is the only thing standing between "twins agree" and a
    // false green, so its substitutions are pinned here rather than trusted.
    expect(normalize(`import x from "@/crypto/syncCode";`)).toBe(
      normalize(`import x from "../crypto/syncCode";`),
    );
    expect(normalize(`import x from "@/crypto/syncCodeV2";`)).not.toBe(
      normalize(`import x from "../crypto/syncCode";`),
    );
    expect(normalize("pwa/src/hooks/useSyncCodeHostVerdict.ts")).toBe(
      normalize("extension/src/dialog/useSyncCodeHostVerdict.ts"),
    );
    expect(normalize("pwa/src/hooks/somethingElse.ts")).not.toBe(
      normalize("extension/src/dialog/useSyncCodeHostVerdict.ts"),
    );
  });

  it("strips JSDoc leaders without eating a `*` that is code", () => {
    // Re-flowed prose still collapses to the same text, blank JSDoc lines and
    // all — that is what makes the comparison survive an 80-column re-wrap.
    expect(normalize("/**\n * one two\n */")).toBe(
      normalize("/**\n * one\n * two\n */"),
    );
    expect(normalize("/**\n * one\n *\n * two\n */")).toBe(
      normalize("/**\n * one two\n */"),
    );

    // But a leading `*` with code right behind it is a generator method, not a
    // leader: stripping it would normalise away a real difference between the
    // twins, which is the one failure mode this whole file exists to prevent.
    expect(normalize("class A {\n  *next() {}\n}")).not.toBe(
      normalize("class A {\n  next() {}\n}"),
    );
  });
});
