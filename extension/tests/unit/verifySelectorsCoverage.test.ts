import { describe, it, expect } from "vitest";
import {
  READMOO_SELECTORS,
  PROFILE_DISPLAY_NAME_STYLE,
} from "moo-family-bookshelf-shared/config/readmoo";
import {
  buildSpecs,
  type SelectorKey,
  type SelectorMap,
  type SelectorSpec,
} from "../../scripts/verify-selectors-specs";

/**
 * Coverage guard for the live selector check (`pnpm e2e:verify:selectors`), which is never run in
 * CI. Every key of `READMOO_SELECTORS` must be named in the `keys` of at least one `SelectorSpec`
 * from `buildSpecs()`, so a selector added to `shared/src/config/readmooSelectors.ts` without a
 * live check turns CI red with the missing key in the message (.claude/rules/test.md → E2E tooling).
 *
 * `keys` must not be padded: every listed key is real and its VALUE appears in the spec's
 * `selector`. Because short values ("img", "div[style]") are substrings of other selectors, a
 * second pass rebuilds the specs from a map of unique sentinels and requires each listed key's
 * sentinel in the selector — that proves the selector is actually built from that key.
 *
 * `PROFILE_DISPLAY_NAME_STYLE` must stay a substring of `profileDisplayName`: the mock-HTML
 * sanitizer in `verify-selectors.ts` builds its display-name regex from that constant.
 */

const ALL_KEYS = Object.keys(READMOO_SELECTORS) as SelectorKey[];

function allSpecs(selectors?: SelectorMap): SelectorSpec[] {
  return Object.values(buildSpecs(selectors)).flat();
}

function sentinel(key: string): string {
  return `__moo_key_${key}__`;
}

function sentinelMap(): SelectorMap {
  return Object.fromEntries(
    ALL_KEYS.map((key) => [key, sentinel(key)]),
  ) as unknown as SelectorMap;
}

describe("buildSpecs coverage of READMOO_SELECTORS", () => {
  it("names every READMOO_SELECTORS key in at least one spec's keys", () => {
    const covered = new Set(allSpecs().flatMap((spec) => spec.keys));
    const missing = ALL_KEYS.filter((key) => !covered.has(key));

    expect(
      missing,
      `READMOO_SELECTORS keys with no live check in verify-selectors-specs.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists at least one key on every spec", () => {
    const keyless = allSpecs()
      .filter((spec) => spec.keys.length === 0)
      .map((spec) => spec.description);

    expect(keyless).toEqual([]);
  });

  it("lists only real READMOO_SELECTORS keys", () => {
    const known = new Set<string>(ALL_KEYS);
    const unknown = allSpecs().flatMap((spec) =>
      spec.keys
        .filter((key) => !known.has(key))
        .map((key) => `${spec.description}: ${key}`),
    );

    expect(unknown).toEqual([]);
  });

  it("contains the value of every listed key in the spec's selector", () => {
    const absent = allSpecs().flatMap((spec) =>
      spec.keys
        .filter((key) => !spec.selector.includes(READMOO_SELECTORS[key]))
        .map((key) => `${spec.description}: ${key}`),
    );

    expect(absent).toEqual([]);
  });

  it("builds each spec's selector from every key it lists", () => {
    const specs = allSpecs(sentinelMap());
    const notBuiltFrom = specs.flatMap((spec) =>
      spec.keys
        .filter((key) => !spec.selector.includes(sentinel(key)))
        .map((key) => `${spec.description}: ${key}`),
    );

    expect(specs.length).toBe(allSpecs().length);
    expect(notBuiltFrom).toEqual([]);
  });
});

describe("PROFILE_DISPLAY_NAME_STYLE", () => {
  it("is part of READMOO_SELECTORS.profileDisplayName", () => {
    expect(READMOO_SELECTORS.profileDisplayName).toContain(
      PROFILE_DISPLAY_NAME_STYLE,
    );
  });
});
