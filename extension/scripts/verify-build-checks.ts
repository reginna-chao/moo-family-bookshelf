/** Pure manifest checks behind verify-build.ts: no file reads, no exit, so a unit test can import them.
 *  Each returns failure messages (no `FAIL:` prefix); `[]` means pass. See docs/architecture.md → Chrome 建置檢查（verify-build.ts）. */
import { READMOO_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmoo";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";

/** Only the fields the checks read, all optional, so a malformed or renamed
 *  field surfaces as a failure message instead of a crash. */
export interface DistManifestFields {
  host_permissions?: string[];
  optional_host_permissions?: string[];
  permissions?: string[];
  options_ui?: { page?: string };
  content_scripts?: { matches?: string[] }[];
  web_accessible_resources?: { matches?: string[]; resources?: string[] }[];
}

/** Pages / scripts the browser itself loads; listing them as web-accessible would let a Readmoo page frame or load them. */
const NEVER_WEB_ACCESSIBLE = ["options.html", "content-store.js"];

/**
 * Failure messages unless `actual` equals `expected` exactly — nothing
 * missing, nothing extra. `undefined` counts as an empty list.
 */
export function checkPatternSet(
  actual: string[] | undefined,
  expected: readonly string[],
  label: string,
): string[] {
  const found = actual ?? [];
  const missing = expected.filter((pattern) => !found.includes(pattern));
  const extra = found.filter((pattern) => !expected.includes(pattern));
  const failures: string[] = [];
  const foundNote = `(found: ${JSON.stringify(actual ?? null)})`;
  if (missing.length > 0) {
    failures.push(`${label} is missing ${missing.join(", ")} ${foundNote}`);
  }
  if (extra.length > 0) {
    failures.push(
      `${label} has unexpected pattern(s) ${extra.join(", ")} ${foundNote}`,
    );
  }
  return failures;
}

/** `checkPatternSet` over EVERY entry: checking only `[0]` would let a second entry ship a
 *  wrong or over-broad match list unnoticed. A missing or empty array fails too. */
function checkEntryMatches(
  entries: { matches?: string[] }[] | undefined,
  label: string,
): string[] {
  if (!entries || entries.length === 0) return [`${label} is missing or empty`];
  return entries.flatMap((entry, index) =>
    checkPatternSet(
      entry.matches,
      READMOO_MATCH_PATTERNS,
      `${label}[${index}].matches`,
    ),
  );
}

function checkNotWebAccessible(manifest: DistManifestFields): string[] {
  const entries = manifest.web_accessible_resources ?? [];
  return entries.flatMap((entry, index) =>
    NEVER_WEB_ACCESSIBLE.filter((file) =>
      (entry.resources ?? []).includes(file),
    ).map(
      (file) =>
        `manifest web_accessible_resources[${index}].resources lists ${file}, which must not be web-accessible`,
    ),
  );
}

/**
 * Every manifest rule verify-build enforces: `host_permissions`, each
 * `content_scripts` and each `web_accessible_resources` entry equal
 * `READMOO_MATCH_PATTERNS`; `optional_host_permissions` equals
 * `READMOO_STORE_MATCH_PATTERNS`; `permissions` holds `"scripting"`;
 * `options_ui.page` is `options.html`; and neither `options.html` nor
 * `content-store.js` is web-accessible.
 */
export function checkManifest(manifest: DistManifestFields): string[] {
  const failures = [
    ...checkPatternSet(
      manifest.host_permissions,
      READMOO_MATCH_PATTERNS,
      "manifest host_permissions",
    ),
    ...checkEntryMatches(manifest.content_scripts, "manifest content_scripts"),
    ...checkEntryMatches(
      manifest.web_accessible_resources,
      "manifest web_accessible_resources",
    ),
    ...checkPatternSet(
      manifest.optional_host_permissions,
      READMOO_STORE_MATCH_PATTERNS,
      "manifest optional_host_permissions",
    ),
  ];
  if (!(manifest.permissions ?? []).includes("scripting")) {
    failures.push('manifest permissions is missing "scripting"');
  }
  if (manifest.options_ui?.page !== "options.html") {
    failures.push(
      `manifest options_ui.page must be "options.html" (found: ${JSON.stringify(manifest.options_ui?.page ?? null)})`,
    );
  }
  return [...failures, ...checkNotWebAccessible(manifest)];
}
