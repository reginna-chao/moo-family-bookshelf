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
 * The same compare now covers every pair `.claude/rules/frontend.md` → Extension
 * ↔ PWA twins classes as `必須一致（parity）` — the identical hooks, the
 * import-only pairs and appEnv — one `TWINS` row each. Every such file carries a
 * `// Twin: <other app's path>` pointer right after its imports, which is what
 * the "names the other app's directory" check below holds it to.
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
 *
 * What normalize() erases — the three differences the twins are ALLOWED to
 * have, and nothing else:
 *   1. the directory each app keeps its own module in (`extension/src/dialog`,
 *      `extension/src/hooks`, `extension/src/utils`, `pwa/src/hooks`,
 *      `pwa/src/utils`, `pwa/src/components`, `{extension,pwa}/tests/helpers`)
 *      — the FILE NAME after it is left intact, so a rename on one side still
 *      fails this test;
 *   2. the directory part of a relative or `@/` import specifier — the
 *      Extension reaches `../api/client` where the PWA reaches `@/api/client`,
 *      so `from "../api/client"` and `from "@/api/client"` both become
 *      `from "<mod>/client"`. This is safe because the final MODULE NAME
 *      survives (importing a different module still fails), only specifiers
 *      that follow `from` / `import` are touched (any other string literal keeps
 *      its directory), and a bare package specifier
 *      (`moo-family-bookshelf-shared/…`, `react`) has no `./`, `../` or `@/`
 *      prefix, so importing the shared module on one side and a local copy on
 *      the other still fails;
 *   3. line wrapping — JSDoc leaders and whitespace runs collapse, so prose
 *      re-flowed to fit 80 columns is not mistaken for a behaviour change.
 * A JSDoc leader is a `*` followed by whitespace or by end of line, and nothing
 * else: Prettier also prints a generator method with `*` at line start
 * (`*next()`), and eating that would let real code compare equal to code that
 * lacks it.
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
    what: "the family-shelf preferences hook",
    extension: "extension/src/dialog/useFamilyShelfPrefs.ts",
    pwa: "pwa/src/hooks/useFamilyShelfPrefs.ts",
    marker: "export function useFamilyShelfPrefs(",
    stake:
      "The load / debounce / flush-on-unmount policy already lives in shared/ (FamilyPrefsSync); these twins are only its React adapter, so a drift here means one app loads, saves or flushes a viewer's private family-shelf preferences differently from the other. Apply the same edit to both files — or move the new logic into shared/src/familyShelf/prefsSync.ts.",
  },
  {
    what: "the load-more pagination hook",
    extension: "extension/src/dialog/useLoadMore.ts",
    pwa: "pwa/src/hooks/useLoadMore.ts",
    marker: "export function useLoadMore<T>({",
    stake:
      "A drift changes how many books one app shows per page, or when it resets the list after a search or filter, while the other app keeps the old behaviour. Apply the same edit to both files — or, since the hook has no app-specific dependency, move it into shared/ and delete both twins.",
  },
  {
    what: "the public-shelf actions hook",
    extension: "extension/src/dialog/usePublicShelfActions.ts",
    pwa: "pwa/src/hooks/usePublicShelfActions.ts",
    marker: "export function usePublicShelfActions({",
    stake:
      "This hook owns every write behind a public share link — create, rename, expiry, reset, delete — and its rule that a failed write never advances the screen past what the server confirmed; a drift lets one app show a link as deleted or saved when it is not. Each side is otherwise tested only through its PublicShareDialog, so apply the same edit to both files.",
  },
  {
    what: "the client-side search hook",
    extension: "extension/src/dialog/useSearch.ts",
    pwa: "pwa/src/hooks/useSearch.ts",
    marker: "export function useSearch<T extends Searchable>(",
    stake:
      "A drift changes how one app matches, debounces or resets the family-shelf search while the other keeps the old behaviour (#382 was exactly that: only the Extension cleared the search when the member filter changed). Apply the same edit to both files — or, since the hook has no app-specific dependency, move it into shared/ and delete both twins.",
  },
  {
    what: "the anchored-position hook",
    extension: "extension/src/hooks/useAnchoredPosition.ts",
    pwa: "pwa/src/hooks/useAnchoredPosition.ts",
    marker: "export function useAnchoredPosition(): {",
    stake:
      "A drift makes the same dropdown open, flip or clamp differently in the two apps. Apply the same edit to both files — or move the pure computeAnchoredPosition into shared/, which has no app-specific dependency.",
  },
  {
    what: "the debounced-callback hook",
    extension: "extension/src/hooks/useDebouncedCallback.ts",
    pwa: "pwa/src/hooks/useDebouncedCallback.ts",
    marker: "export function useDebouncedCallback<Args extends unknown[]>(",
    stake:
      "Both apps debounce server writes through this hook, and its unmount cleanup is what stops a queued write from firing after the dialog is gone; a drift lets one app send writes the other would have dropped. Apply the same edit to both files.",
  },
  {
    what: "the timed-flag hook",
    extension: "extension/src/hooks/useTimedFlag.ts",
    pwa: "pwa/src/hooks/useTimedFlag.ts",
    marker: "export function useTimedFlag(",
    stake:
      "A drift changes how long a transient confirmation such as 已複製 stays on screen, or whether its timer survives an unmount, in one app only. Apply the same edit to both files.",
  },
  {
    what: "the app-environment resolver",
    extension: "extension/src/utils/appEnv.ts",
    pwa: "pwa/src/utils/appEnv.ts",
    marker: "export function getAppEnv(): AppEnv {",
    stake:
      "It reads each app's own import.meta.env.MODE, so it stays per app, but the Vite-mode → local / dev / prod mapping must agree: a drift makes one app treat a build as a different environment than the other does. Apply the same edit to both files.",
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
    // No permitted difference at all. The marker is also data in this row, which
    // still proves normalisation left the file standing; the real anchor is the compare.
    marker: "function normalize(source: string): string {",
    stake:
      "Each suite runs only its own copy — that is the whole point of duplicating this file — so a copy left un-updated does not run for that app's PRs, and the guarantee holds in one direction only. Apply the same edit to both copies.",
  },
];

/** Placeholder left where a known-divergent fragment used to be. */
const TWIN_DIR = "<twin-dir>";

/** Placeholder left where an import specifier's directory part used to be. */
const IMPORT_DIR = "<mod>";

/** Erase the three differences the twins are ALLOWED to have, and nothing else.
 *  See the header → "What normalize() erases". */
function normalize(source: string): string {
  return source
    .replace(
      /extension\/src\/(?:dialog|hooks|utils)|pwa\/src\/(?:hooks|utils|components)|(?:extension|pwa)\/tests\/helpers/g,
      TWIN_DIR,
    )
    .replace(
      /(\b(?:from|import)\s*\(?\s*)(["'])(?:@\/|(?:\.\.?\/)+)(?:[\w-]+\/)*/g,
      `$1$2${IMPORT_DIR}/`,
    )
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

  it("normalizes away the twin directory without hiding a real rename", () => {
    // The normaliser is the only thing standing between "twins agree" and a
    // false green, so its substitutions are pinned here rather than trusted.
    expect(normalize("pwa/src/hooks/useSyncCodeHostVerdict.ts")).toBe(
      normalize("extension/src/dialog/useSyncCodeHostVerdict.ts"),
    );
    expect(normalize("pwa/src/hooks/somethingElse.ts")).not.toBe(
      normalize("extension/src/dialog/useSyncCodeHostVerdict.ts"),
    );
    expect(normalize("extension/src/hooks/x.ts")).toBe(
      normalize("pwa/src/hooks/x.ts"),
    );
    expect(normalize("extension/src/hooks/x.ts")).not.toBe(
      normalize("pwa/src/hooks/y.ts"),
    );
    expect(normalize("extension/src/utils/appEnv.ts")).toBe(
      normalize("pwa/src/utils/appEnv.ts"),
    );
  });

  it("normalizes away an import's directory without hiding a different module", () => {
    const importOf = (specifier: string) =>
      normalize(`import { x } from "${specifier}";`);

    expect(importOf("@/api/client")).toBe(importOf("../api/client"));
    expect(importOf("./publicShareMessages")).toBe(
      importOf("@/utils/publicShareMessages"),
    );
    expect(importOf("../hooks/useDebouncedCallback")).toBe(
      importOf("@/hooks/useDebouncedCallback"),
    );
    expect(importOf("../../x/y")).toBe(importOf("@/y"));
    expect(normalize(`const m = await import("../api/client");`)).toBe(
      normalize(`const m = await import("@/api/client");`),
    );

    // The module name survives, and a package specifier is never erased, so a
    // local copy standing in for the shared module still fails the compare.
    expect(importOf("../api/client")).not.toBe(importOf("../api/clientV2"));
    expect(importOf("moo-family-bookshelf-shared/crypto/syncCode")).not.toBe(
      importOf("@/crypto/syncCode"),
    );
    expect(importOf("react")).not.toBe(importOf("./react"));

    // Only import specifiers lose their directory; any other string keeps it.
    expect(normalize(`const p = "./a/b";`)).not.toBe(
      normalize(`const p = "./c/b";`),
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
    // leader: stripping it would hide a real twin difference, this file's one failure mode.
    expect(normalize("class A {\n  *next() {}\n}")).not.toBe(
      normalize("class A {\n  next() {}\n}"),
    );
  });
});
