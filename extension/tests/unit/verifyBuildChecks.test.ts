import { describe, it, expect } from "vitest";
import { READMOO_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmoo";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";
import {
  checkManifest,
  checkPatternSet,
  type DistManifestFields,
} from "../../scripts/verify-build-checks";

/**
 * The pure manifest checks behind `scripts/verify-build.ts` (`scripts/verify-build-checks.ts`), which
 * `pnpm build` runs against `dist/manifest.json`. Each check returns failure messages and `[]` means
 * pass, so every rule is pinned by a manifest that breaks exactly that rule and must yield exactly one
 * message naming it — next to a passing baseline, so a check that always passed (or always failed)
 * shows up here instead of in a shipped build.
 */

function passingManifest(): DistManifestFields {
  return {
    host_permissions: [...READMOO_MATCH_PATTERNS],
    optional_host_permissions: [...READMOO_STORE_MATCH_PATTERNS],
    permissions: ["storage", "scripting"],
    options_ui: { page: "options.html" },
    content_scripts: [{ matches: [...READMOO_MATCH_PATTERNS] }],
    web_accessible_resources: [
      {
        matches: [...READMOO_MATCH_PATTERNS],
        resources: ["content-dialog.js", "secure-frame.html"],
      },
    ],
  };
}

describe("checkPatternSet", () => {
  const EXPECTED = ["https://a.example/*", "https://b.example/*"];

  it("passes an exact match in any order", () => {
    expect(checkPatternSet([...EXPECTED].reverse(), EXPECTED, "x")).toEqual([]);
  });

  it("names a missing pattern", () => {
    const failures = checkPatternSet([EXPECTED[0]], EXPECTED, "label");

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("label is missing https://b.example/*");
  });

  it("names an unexpected pattern", () => {
    const failures = checkPatternSet(
      [...EXPECTED, "<all_urls>"],
      EXPECTED,
      "label",
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("label has unexpected pattern(s) <all_urls>");
  });

  it("reports both a missing and an extra pattern", () => {
    expect(
      checkPatternSet([EXPECTED[0], "https://c.example/*"], EXPECTED, "x"),
    ).toHaveLength(2);
  });

  it("treats an absent list as empty", () => {
    const failures = checkPatternSet(undefined, EXPECTED, "label");

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("(found: null)");
  });
});

describe("checkManifest", () => {
  it("passes a manifest that follows every rule", () => {
    expect(checkManifest(passingManifest())).toEqual([]);
  });

  it.each<[string, (m: DistManifestFields) => void, string]>([
    [
      "an optional_host_permissions entry missing",
      (m) => {
        m.optional_host_permissions = [];
      },
      "optional_host_permissions is missing",
    ],
    [
      "an extra optional_host_permissions entry",
      (m) => {
        m.optional_host_permissions = [
          ...READMOO_STORE_MATCH_PATTERNS,
          "https://readmoo.com/*",
        ];
      },
      "optional_host_permissions has unexpected",
    ],
    [
      "no optional_host_permissions at all",
      (m) => {
        delete m.optional_host_permissions;
      },
      "optional_host_permissions is missing",
    ],
    [
      "the scripting permission missing",
      (m) => {
        m.permissions = ["storage"];
      },
      'permissions is missing "scripting"',
    ],
    [
      "a wrong options page",
      (m) => {
        m.options_ui = { page: "popup.html" };
      },
      'options_ui.page must be "options.html"',
    ],
    [
      "no options page",
      (m) => {
        delete m.options_ui;
      },
      'options_ui.page must be "options.html"',
    ],
    [
      "options.html made web-accessible",
      (m) => {
        m.web_accessible_resources![0].resources!.push("options.html");
      },
      "lists options.html, which must not be web-accessible",
    ],
    [
      "content-store.js made web-accessible",
      (m) => {
        m.web_accessible_resources![0].resources!.push("content-store.js");
      },
      "lists content-store.js, which must not be web-accessible",
    ],
    [
      "the store pattern added to host_permissions",
      (m) => {
        m.host_permissions = [
          ...READMOO_MATCH_PATTERNS,
          ...READMOO_STORE_MATCH_PATTERNS,
        ];
      },
      "host_permissions has unexpected",
    ],
    [
      "a second content script with a wrong match list",
      (m) => {
        m.content_scripts!.push({ matches: ["https://readmoo.com/book/*"] });
      },
      "content_scripts[1].matches is missing",
    ],
    [
      "no content scripts",
      (m) => {
        m.content_scripts = [];
      },
      "content_scripts is missing or empty",
    ],
    [
      "a web-accessible entry with a wrong match list",
      (m) => {
        m.web_accessible_resources![0].matches = ["<all_urls>"];
      },
      "web_accessible_resources[0].matches is missing",
    ],
  ])("fails with one message for %s", (_name, breakRule, message) => {
    const manifest = passingManifest();
    breakRule(manifest);

    const failures = checkManifest(manifest);

    expect(failures.filter((f) => f.includes(message))).toHaveLength(1);
    // The other rules still pass: only the broken one is reported.
    expect(failures.length).toBeLessThanOrEqual(2);
  });
});
