/** Playwright helpers shared by verify-selectors.ts and verify-selectors-flows.ts; no `main()` here.
 *  See .claude/rules/test.md → E2E tooling (extension/scripts). */

import type { Locator, Page } from "@playwright/test";
import {
  LIBRARY_HASH,
  ME_HASH,
  READMOO_HOST_LEGACY,
  READMOO_HOST_NEXT,
  READMOO_SELECTORS,
  readmooAppUrl,
} from "moo-family-bookshelf-shared/config/readmoo";
import {
  resultIcon,
  type CheckResult,
  type SelectorSpec,
  type SiteId,
} from "./verify-selectors-specs";

export interface Site {
  id: SiteId;
  label: string;
  libraryUrl: string;
  meUrl: string;
  /** Only the primary site decides the process exit code. */
  primary: boolean;
}

export const SITES: readonly Site[] = [
  {
    id: "next",
    label: `新站 ${READMOO_HOST_NEXT}`,
    libraryUrl: readmooAppUrl(READMOO_HOST_NEXT, LIBRARY_HASH),
    meUrl: readmooAppUrl(READMOO_HOST_NEXT, ME_HASH),
    primary: true,
  },
  {
    id: "legacy",
    label: `舊站 ${READMOO_HOST_LEGACY}`,
    libraryUrl: readmooAppUrl(READMOO_HOST_LEGACY, LIBRARY_HASH),
    meUrl: readmooAppUrl(READMOO_HOST_LEGACY, ME_HASH),
    primary: false,
  },
];

/** Navigation options shared by every page load of the tool. */
export const NAV_OPTIONS = {
  waitUntil: "domcontentloaded",
  timeout: 30_000,
} as const;

/** How to preview a matched element in the console. */
export type SampleMode = "attr" | "text";

/** Pick a representative sample for the matched element. */
export async function readSample(
  locator: Locator,
  selector: string,
  mode: SampleMode,
): Promise<string | undefined> {
  if (mode === "text") {
    return (await locator.textContent())?.trim() || undefined;
  }
  if (selector.includes("[title]")) {
    return (await locator.getAttribute("title")) ?? undefined;
  }
  if (selector.includes("[src]")) {
    return (await locator.getAttribute("src")) ?? undefined;
  }
  if (selector.includes("[href]")) {
    return (await locator.getAttribute("href")) ?? undefined;
  }
  if (selector.includes("[id^=")) {
    return (await locator.getAttribute("id")) ?? undefined;
  }
  return undefined;
}

/** Outcome of one spec on one site, before it becomes a `CheckResult`. */
export interface Observation {
  found: boolean;
  count: number;
  sample?: string;
  skippedReason?: string;
}

/** Build the `CheckResult` for one spec and print its console line. */
export function recordResult(
  spec: SelectorSpec,
  site: Site,
  observation: Observation,
): CheckResult {
  const applicable = spec.appliesTo === "both" || spec.appliesTo === site.id;
  const result: CheckResult = {
    siteId: site.id,
    selector: spec.selector,
    description: spec.description,
    required: spec.required && applicable,
    applicable,
    ...observation,
  };
  const { found, count, sample, skippedReason } = observation;
  const countStr = found ? `(${count} 個)` : "";
  const sampleStr = sample ? ` → ${sample}` : "";
  const skipStr = skippedReason ? `（無法檢查：${skippedReason}）` : "";
  console.log(
    `  ${resultIcon(result)} ${spec.selector} — ${spec.description} ${countStr}${sampleStr}${skipStr}`,
  );
  return result;
}

export async function checkSelectors(
  page: Page,
  specs: readonly SelectorSpec[],
  site: Site,
  sampleMode: SampleMode,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const spec of specs) {
    const count = await page.locator(spec.selector).count();
    const found = count > 0;
    const sample = found
      ? await readSample(
          page.locator(spec.selector).first(),
          spec.selector,
          sampleMode,
        )
      : undefined;
    results.push(recordResult(spec, site, { found, count, sample }));
  }
  return results;
}

/** Mark every spec as not checkable (no Playwright query); never counted as a failure. */
export function skipSpecs(
  specs: readonly SelectorSpec[],
  site: Site,
  reason: string,
): CheckResult[] {
  return specs.map((spec) =>
    recordResult(spec, site, { found: false, count: 0, skippedReason: reason }),
  );
}

/** Mark every spec as missing: the page could not be brought to the state it needs. */
export function failSpecs(
  specs: readonly SelectorSpec[],
  site: Site,
): CheckResult[] {
  return specs.map((spec) =>
    recordResult(spec, site, { found: false, count: 0 }),
  );
}

/** Wait for the library grid; the primary site also allows a 5-min manual login, the legacy site
 *  gives up quickly so a logged-out legacy account cannot stall (or fail) the run. */
export async function waitForLibrary(page: Page, site: Site): Promise<boolean> {
  const libraryItem = page.locator(READMOO_SELECTORS.libraryItem).first();
  const quick = await libraryItem
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (quick) return true;

  if (!site.primary) {
    console.log(
      `\n⚠️  ${site.label}：未偵測到書籍（可能未登入或無書），略過檢查。`,
    );
    return false;
  }

  console.log(
    "\n⚠️  未偵測到書籍。請在 Chrome 中登入讀墨，登入後會自動繼續...",
  );
  console.log(`   （登入後請導航到書櫃頁面：${site.libraryUrl}）\n`);
  return libraryItem
    .waitFor({ state: "visible", timeout: 300_000 }) // 5 min to log in
    .then(() => true)
    .catch(() => false);
}

/** Fully reload the library page, dropping any modal or unconfirmed choice a flow left behind.
 *  `goto` alone is a same-document hash navigation when already there, hence the `reload`. */
export async function reloadLibrary(page: Page, site: Site): Promise<boolean> {
  if (page.url() !== site.libraryUrl) {
    await page.goto(site.libraryUrl, NAV_OPTIONS);
  }
  await page.reload(NAV_OPTIONS);
  return waitForLibrary(page, site);
}
