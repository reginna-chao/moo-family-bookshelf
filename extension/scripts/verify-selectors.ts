/** Check the scraper's selectors against live Readmoo (new + legacy site); `--update-mock` regenerates the fixture.
 *  Usage, exit code, sanitizing, guard cards: .claude/rules/test.md → E2E tooling (extension/scripts). */

import { chromium, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  LIBRARY_HASH,
  ME_HASH,
  READMOO_HOST_LEGACY,
  READMOO_HOST_NEXT,
  READMOO_SELECTORS,
  readmooAppUrl,
} from "moo-family-bookshelf-shared/config/readmoo";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_OUTPUT = resolve(
  __dirname,
  "..",
  "tests",
  "e2e",
  "fixtures",
  "mock-readmoo.html",
);

type SiteId = "next" | "legacy";

interface Site {
  id: SiteId;
  label: string;
  libraryUrl: string;
  meUrl: string;
  /** Only the primary site decides the process exit code. */
  primary: boolean;
}

const SITES: readonly Site[] = [
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

interface SelectorSpec {
  selector: string;
  description: string;
  required: boolean;
  /** "both" = expected on every site; otherwise only on the named one. */
  appliesTo: SiteId | "both";
}

const ITEM = READMOO_SELECTORS.libraryItem;

// Library + #/me selectors checked pass/fail, grouped by page. Not checked: readmoo-lend.ts's
// detailTrigger* selectors; borrowedBadge is only counted during capture.
const LIBRARY_SELECTORS: readonly SelectorSpec[] = [
  {
    selector: ITEM,
    description: "書籍容器",
    required: true,
    appliesTo: "both",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.title}`,
    description: "書名（title 屬性）",
    required: true,
    appliesTo: "both",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.coverImg}`,
    description: "封面圖片",
    required: true,
    appliesTo: "both",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.overlay}`,
    description: "hover 後的操作區（新站）",
    required: true,
    appliesTo: "next",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.overlayLegacy}`,
    description: "hover 後的操作區（舊站 fallback）",
    required: true,
    appliesTo: "legacy",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.readerLink}`,
    description: "閱讀連結（含 bookId，新站）",
    required: true,
    appliesTo: "next",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.readerLinkLegacy}`,
    description: "閱讀連結（含 bookId，舊站 fallback）",
    required: true,
    appliesTo: "legacy",
  },
  {
    selector: `${ITEM} ${READMOO_SELECTORS.privacyId}`,
    description: "fallback bookId",
    required: false,
    appliesTo: "both",
  },
  {
    selector: READMOO_SELECTORS.topNavBtn,
    description: "頂部導覽列按鈕",
    required: false,
    appliesTo: "both",
  },
];

const ME_SELECTORS: readonly SelectorSpec[] = [
  {
    selector: READMOO_SELECTORS.mePanel,
    description: "個人資料面板",
    required: true,
    appliesTo: "both",
  },
  {
    selector: `${READMOO_SELECTORS.mePanel} div[style*='font-size: 16px']`,
    description: "顯示名稱",
    required: true,
    appliesTo: "both",
  },
];

interface CheckResult {
  siteId: SiteId;
  selector: string;
  description: string;
  /** Required *on this site* (spec.required narrowed by applicability). */
  required: boolean;
  applicable: boolean;
  found: boolean;
  count: number;
  sample?: string;
}

interface SiteReport {
  site: Site;
  /** False when the library never rendered (logged out / empty account). */
  reachable: boolean;
  results: CheckResult[];
  libraryHtml: string;
  meHtml: string;
}

/** How to preview a matched element in the console. */
type SampleMode = "attr" | "text";

/** Pick a representative sample for the matched element. */
async function readSample(
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

function resultIcon(r: CheckResult): string {
  if (!r.applicable) return r.found ? "ℹ️" : "➖";
  if (r.found) return "✅";
  return r.required ? "❌" : "⚠️";
}

async function checkSelectors(
  page: Page,
  specs: readonly SelectorSpec[],
  site: Site,
  sampleMode: SampleMode,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const spec of specs) {
    const applicable = spec.appliesTo === "both" || spec.appliesTo === site.id;
    const count = await page.locator(spec.selector).count();
    const found = count > 0;
    const sample = found
      ? await readSample(
          page.locator(spec.selector).first(),
          spec.selector,
          sampleMode,
        )
      : undefined;

    const result: CheckResult = {
      siteId: site.id,
      selector: spec.selector,
      description: spec.description,
      required: spec.required && applicable,
      applicable,
      found,
      count,
      sample,
    };
    results.push(result);

    const countStr = found ? `(${count} 個)` : "";
    const sampleStr = sample ? ` → ${sample}` : "";
    console.log(
      `  ${resultIcon(result)} ${spec.selector} — ${spec.description} ${countStr}${sampleStr}`,
    );
  }
  return results;
}

/** Wait for the library grid; the primary site also allows a 5-min manual login, the legacy site
 *  gives up quickly so a logged-out legacy account cannot stall (or fail) the run. */
async function waitForLibrary(page: Page, site: Site): Promise<boolean> {
  const libraryItem = page.locator(ITEM).first();
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

/** Capture up to 5 hovered `.library-item` fragments plus the nav bar. */
async function captureLibraryHtml(page: Page): Promise<string> {
  const items = page.locator(ITEM);
  const maxItems = Math.min(await items.count(), 5);
  const fragments: string[] = [];

  for (let i = 0; i < maxItems; i++) {
    // Trigger hover to reveal .openbook-overlay
    await items.nth(i).hover();
    await page.waitForTimeout(300);
    fragments.push(await items.nth(i).evaluate((el) => el.outerHTML));
  }

  const borrowedCount = await page
    .locator(`${ITEM} ${READMOO_SELECTORS.borrowedBadge}`)
    .count();
  if (borrowedCount > 0) {
    console.log(`\n  ℹ️  發現 ${borrowedCount} 本借入書籍`);
  }

  const navBar = page.locator(READMOO_SELECTORS.topNavBtn).first();
  const navBarHtml = (await navBar.isVisible())
    ? await navBar.evaluate((el) => el.parentElement?.outerHTML ?? "")
    : "";

  return `${navBarHtml}\n\n${fragments
    .map((f, i) => `    <!-- 書籍 ${i + 1} -->\n    ${f}`)
    .join("\n\n")}`;
}

/** Replicate scraper.ts's email heuristic against the live profile panel. */
async function checkEmailHeuristic(page: Page): Promise<void> {
  const emailFound = await page.evaluate((panelSelector) => {
    const panel = document.querySelector(panelSelector);
    if (!panel) return null;
    const candidates = panel.querySelectorAll<HTMLElement>("div[style]");
    for (const el of candidates) {
      if (el.childElementCount > 0) continue;
      const text = el.textContent?.trim() ?? "";
      if (text.includes("@") && text.includes(".")) return text;
    }
    return null;
  }, READMOO_SELECTORS.mePanel);

  console.log(
    `  ${emailFound ? "✅" : "❌"} Email 偵測邏輯 — div[style] 含 @ 和 .${
      emailFound ? ` → "${emailFound}"` : ""
    }`,
  );
}

async function checkLibraryPage(
  page: Page,
  site: Site,
  captureHtml: boolean,
): Promise<{ reachable: boolean; results: CheckResult[]; html: string }> {
  console.log(`\n📖 [${site.label}] 正在載入書櫃頁面 ${site.libraryUrl} ...`);
  await page.goto(site.libraryUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const reachable = await waitForLibrary(page, site);
  if (!reachable) return { reachable, results: [], html: "" };

  // Hover the first item so the overlay layer renders before we query it.
  const firstItem = page.locator(ITEM).first();
  if (await firstItem.isVisible()) {
    await firstItem.hover();
    await page.waitForTimeout(500);
  }

  console.log(`\n--- [${site.label}] 書櫃頁面選擇器 ---\n`);
  const results = await checkSelectors(page, LIBRARY_SELECTORS, site, "attr");
  const html = captureHtml ? await captureLibraryHtml(page) : "";
  return { reachable, results, html };
}

async function checkMePage(
  page: Page,
  site: Site,
  captureHtml: boolean,
): Promise<{ results: CheckResult[]; html: string }> {
  console.log(`\n📋 [${site.label}] 正在載入個人頁面 ${site.meUrl} ...`);
  await page.goto(site.meUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page
    .locator(READMOO_SELECTORS.mePanel)
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {
      console.log(`⚠️  未找到 ${READMOO_SELECTORS.mePanel}，頁面可能未登入`);
    });

  console.log(`\n--- [${site.label}] 個人頁面選擇器 ---\n`);
  const results = await checkSelectors(page, ME_SELECTORS, site, "text");
  await checkEmailHeuristic(page);

  const mePanel = page.locator(READMOO_SELECTORS.mePanel);
  const html =
    captureHtml && (await mePanel.isVisible())
      ? await mePanel.evaluate((el) => el.outerHTML)
      : "";
  return { results, html };
}

async function runSite(
  page: Page,
  site: Site,
  captureHtml: boolean,
): Promise<SiteReport> {
  console.log(`\n${"=".repeat(50)}\n=== ${site.label} ===\n${"=".repeat(50)}`);

  const library = await checkLibraryPage(page, site, captureHtml);
  if (!library.reachable) {
    return {
      site,
      reachable: false,
      results: [],
      libraryHtml: "",
      meHtml: "",
    };
  }

  const me = await checkMePage(page, site, captureHtml);
  return {
    site,
    reachable: true,
    results: [...library.results, ...me.results],
    libraryHtml: library.html,
    meHtml: me.html,
  };
}

function failuresOf(report: SiteReport): CheckResult[] {
  return report.results.filter((r) => r.required && !r.found);
}

function printSiteSummary(report: SiteReport): void {
  const { site } = report;
  console.log(`\n--- [${site.label}] 結果 ---\n`);

  if (!report.reachable) {
    console.log("⚠️  無法檢查（未偵測到書籍，可能未登入或帳號無書）。");
    return;
  }

  const failed = failuresOf(report);
  const warnings = report.results.filter(
    (r) => r.applicable && !r.required && !r.found,
  );

  if (failed.length === 0) {
    console.log("✅ 所有必要選擇器都存在。");
  } else {
    console.log(`❌ ${failed.length} 個必要選擇器失效：`);
    for (const f of failed) {
      console.log(`   - ${f.selector} (${f.description})`);
    }
  }

  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} 個非必要選擇器未找到（可能正常）：`);
    for (const w of warnings) {
      console.log(`   - ${w.selector} (${w.description})`);
    }
  }
}

/** Print the cross-site verdict; exit code 1 only when the PRIMARY site is unreachable or fails a required
 *  selector, legacy problems are warnings. Why: .claude/rules/test.md → E2E tooling (extension/scripts). */
function printFinalSummary(reports: readonly SiteReport[]): number {
  console.log("\n=== 總結 ===\n");

  let exitCode = 0;
  for (const report of reports) {
    const failed = report.reachable ? failuresOf(report) : [];
    const ok = report.reachable && failed.length === 0;

    if (report.site.primary) {
      if (!ok) exitCode = 1;
      const detail = report.reachable
        ? `${failed.length} 個必要選擇器失效`
        : "無法檢查";
      console.log(
        ok
          ? `✅ ${report.site.label}：通過`
          : `❌ ${report.site.label}：${detail}`,
      );
      continue;
    }

    const detail = report.reachable
      ? `${failed.length} 個必要選擇器失效（不影響 exit code）`
      : "無法檢查（不影響 exit code）";
    console.log(
      ok
        ? `✅ ${report.site.label}：通過`
        : `⚠️  ${report.site.label}：${detail}`,
    );
  }

  if (exitCode !== 0) {
    console.log("\n   → 需要更新 scraper.ts / readmoo-lend.ts 和 mock HTML");
  }
  return exitCode;
}

async function main() {
  const updateMock = process.argv.includes("--update-mock");

  console.log("=== Readmoo 選擇器驗證工具（新站 + 舊站）===\n");

  // Use a dedicated profile directory — avoids locking issues with your main Chrome
  // First run: you'll need to log into Readmoo manually. Cookie persists for future runs.
  const profileDir = resolve(__dirname, "..", ".verify-selectors-profile");
  console.log(`Profile 目錄: ${profileDir}`);
  console.log(
    "（首次執行請在開啟的 Chrome 中登入讀墨，登入後腳本會自動繼續）\n",
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
    ],
    timeout: 30_000,
  });

  console.log("✅ Chrome 已啟動\n");

  const page = context.pages()[0] || (await context.newPage());
  const reports: SiteReport[] = [];

  try {
    for (const site of SITES) {
      // Mock HTML is only ever generated from the primary (new) site.
      reports.push(await runSite(page, site, updateMock && site.primary));
    }

    for (const report of reports) {
      printSiteSummary(report);
    }

    const exitCode = printFinalSummary(reports);

    if (updateMock) {
      writeMockHtml(reports);
    }
    return exitCode;
  } finally {
    await context.close();
  }
}

function writeMockHtml(reports: readonly SiteReport[]): void {
  const primary = reports.find((r) => r.site.primary);
  if (!primary || !primary.reachable || failuresOf(primary).length > 0) {
    console.log(
      "\n⚠️  新站選擇器未全數通過，跳過 mock 產生。請先更新 scraper.ts。",
    );
    return;
  }
  console.log("\n📝 正在產生 mock-readmoo.html...");
  const mockHtml = generateMockHtml(primary.libraryHtml, primary.meHtml);
  writeFileSync(MOCK_OUTPUT, mockHtml, "utf-8");
  console.log(`✅ 已寫入 ${MOCK_OUTPUT}`);
  reportResidualIds(mockHtml);
  console.log(
    `⚠️  提醒：書名、封面網址與 bookId 皆已合成化（測試書籍 N / placeholder / ${SYNTHETIC_ID_PREFIX}${SYNTHETIC_ID_START} 起跳），`,
  );
  console.log(
    "   與原本 fixture 的固定書名不同。E2E spec 若對特定書名或 bookId 有斷言，請人工核對後再提交。",
  );
}

/** Hand-written legacy `.openbook` card (書籍 5) appended to EVERY generated fixture; never convert it to
 *  the new-site structure. Why: .claude/rules/test.md → E2E tooling (extension/scripts). */
const LEGACY_GUARD_CARD = `    <!--
      書籍 5：legacy 結構迴歸守衛。
      刻意保留舊站 read.readmoo.com 的 .openbook 結構（reader-link 在 .openbook 內），
      確保 queryWithLegacyFallback 的舊站路徑不會在改版中被靜默弄壞。請勿改成新站結構。
      本卡片由 verify-selectors.ts 手寫產生，--update-mock 重新產生時永遠保留。
    -->
    <div class="library-item" data-testid="book-5">
      <img class="cover-img" src="https://via.placeholder.com/80x110?text=Book5" alt="cover" />
      <div class="info">
        <span class="title" title="刻意練習">刻意練習</span>
        <span class="author">Anders Ericsson</span>
      </div>
      <div class="openbook">
        <div class="detail"><span><i class="mo mo-ellipsis-horizontal"></i></span></div>
        <a class="reader-link" href="https://readmoo.com/api/reader/210439468000105">閱讀</a>
      </div>
      <div class="privacy" id="privacy-210439468000105"></div>
    </div>`;

/** Hand-written new-site card (書籍 4) whose only id is a short 8-digit `privacy-*` one, appended to EVERY
 *  fixture; never lengthen the id or add a reader-link. Why: .claude/rules/test.md → E2E tooling (extension/scripts). */
const SHORT_ID_GUARD_CARD = `    <!--
      書籍 4：短 id 守衛卡。新站結構但沒有 a.reader-link → 只剩 .privacy fallback。
      新站的 privacy id 是 8 碼「內部 id」，不是 15 碼書籍 id（真實抓包確認），
      拿它當 bookId 會上傳一本永遠對不到真書的幽靈書。scraper 的長度守衛
      （extractFallbackId 只收 12 碼以上）因此會直接跳過這本書。
      所以這張卡的預期行為是「不會出現在個人書櫃」——請勿把 id 改長。
      本卡片由 verify-selectors.ts 手寫產生，--update-mock 重新產生時永遠保留。
    -->
    <div class="library-item" data-testid="book-4">
      <div class="cover-outer">
        <div class="cover-container">
          <div class="cover">
            <!-- 無 a.reader-link，bookId 只能從 .privacy 的 id 取得 -->
            <img class="cover-img" src="https://via.placeholder.com/80x110?text=Book4" alt="cover" />
          </div>
        </div>
        <div class="rendition-overlay"><div class="label rendition">流式</div></div>
        <div class="desktop-overlay">
          <div class="openbook-overlay" style="opacity: 0; pointer-events: none;">
            <div class="detail"><span><i class="mo mo-ellipsis-horizontal"></i></span></div>
            <div class="privacy" id="privacy-18548672"><span><i class="mo mo-lock-off"></i></span></div>
            <div class="menu-status"><div class="dropdown"><button class="dropdown-toggle">正在閱讀</button></div></div>
          </div>
        </div>
      </div>
      <div class="info">
        <div class="progress"><div class="progress-bar"></div></div>
        <div class="title" title="薩提爾的對話練習">薩提爾的對話練習</div>
        <div class="star-rating"></div>
      </div>
      <div class="select-overlay"></div>
    </div>`;

/** Synthetic bookId shape reused from the committed fixture: `2104394680001NN`. */
const SYNTHETIC_ID_PREFIX = "2104394680001";

/** First suffix for captured cards: `01`–`05` are reserved for the guard cards (the legacy guard pins
 *  `210439468000105`), so a regenerated fixture never mints a colliding id (see .claude/rules/test.md). */
const SYNTHETIC_ID_START = 11;

/** Id segment of a reader-link href, a `privacy-{id}` element id, or a `data-moo-book-id` attribute
 *  (stamped by our fiber bridge; present only if the capture ran with the extension loaded). */
const REAL_ID_PATTERN =
  /(?:reader\/|privacy-|data-moo-book-id=")([A-Za-z0-9_-]+)/g;

/** Any 12+ digit run left after sanitizing is a bookId-shaped value we failed to recognise;
 *  used only to warn the operator (see `reportResidualIds`). */
const LONG_DIGIT_RUN_PATTERN = /\d{12,}/g;

/** Matches a `.title`-classed element together with its text node. */
const TITLE_ELEMENT_PATTERN =
  /<(\w+)([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([^<]*)<\/\1>/g;

/** Rewrite every real Readmoo id to a synthetic 15-digit one in first-appearance order; the same real id
 *  always maps to the same synthetic one, so a card's reader-link href and `privacy-*` id stay consistent. */
function sanitizeLibraryIds(html: string): string {
  const idMap = new Map<string, string>();
  return html.replace(REAL_ID_PATTERN, (match, realId: string) => {
    let synthetic = idMap.get(realId);
    if (!synthetic) {
      const suffix = SYNTHETIC_ID_START + idMap.size;
      synthetic = `${SYNTHETIC_ID_PREFIX}${String(suffix).padStart(2, "0")}`;
      idMap.set(realId, synthetic);
    }
    return match.replace(realId, synthetic);
  });
}

/** The standalone `title` attribute only: `\btitle=` also matches the tail of `data-title=` / `aria-title=`
 *  (a word boundary holds after `-`), so the lookbehind rejects a hyphen or word character before it. */
const TITLE_ATTRIBUTE_PATTERN = /(?<![-\w])title="[^"]*"/;

/** Replace every `.title` element's `title` attribute AND text with a fake name. */
function sanitizeLibraryTitles(html: string): string {
  let index = 0;
  return html.replace(
    TITLE_ELEMENT_PATTERN,
    (_match, tag: string, attrs: string) => {
      index += 1;
      const name = `測試書籍 ${index}`;
      const safeAttrs = attrs.replace(
        TITLE_ATTRIBUTE_PATTERN,
        `title="${name}"`,
      );
      return `<${tag}${safeAttrs}>${name}</${tag}>`;
    },
  );
}

/** Replace every `<img>`'s `src` / `data-src` / `srcset` with a placeholder and `alt` with a fixed literal,
 *  so no Readmoo CDN path and no real title (Readmoo puts it in `alt`) reaches the fixture. */
function sanitizeLibraryImages(html: string): string {
  let index = 0;
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    index += 1;
    const placeholder = `https://via.placeholder.com/80x110?text=Book${index}`;
    return tag
      .replace(/\b(src|data-src)="[^"]*"/g, `$1="${placeholder}"`)
      .replace(/\bsrcset="[^"]*"/g, `srcset="${placeholder}"`)
      .replace(/\balt="[^"]*"/g, 'alt="cover"');
  });
}

/** Reading progress is carried as an inline width on `.progress-bar` — drop it. */
function sanitizeProgressBars(html: string): string {
  return html.replace(
    /<(\w+)\b([^>]*\bclass="[^"]*\bprogress-bar\b[^"]*"[^>]*)>/g,
    (_match, tag: string, attrs: string) =>
      `<${tag}${attrs.replace(/\s*\bstyle="[^"]*"/g, "")}>`,
  );
}

/** Strip titles, real bookIds, CDN cover URLs and reading progress before the git-tracked fixture; ids go
 *  FIRST so the id map is built from the original markup. See .claude/rules/test.md → E2E tooling (extension/scripts). */
function sanitizeLibraryHtml(html: string): string {
  return sanitizeProgressBars(
    sanitizeLibraryImages(sanitizeLibraryTitles(sanitizeLibraryIds(html))),
  );
}

/** Last line of defence: warn when a bookId-shaped value survived sanitizing — Readmoo may now carry
 *  the id somewhere `sanitizeLibraryIds` does not know, which would ship a real bookId in the fixture. */
function reportResidualIds(mockHtml: string): void {
  const residual = (mockHtml.match(LONG_DIGIT_RUN_PATTERN) ?? []).filter(
    (run) => !run.startsWith(SYNTHETIC_ID_PREFIX),
  );
  if (residual.length === 0) return;

  console.log(
    `\n🚨 消毒後仍偵測到 ${residual.length} 個疑似真實 bookId（12 碼以上數字）：`,
  );
  console.log(`   ${[...new Set(residual)].join(", ")}`);
  console.log(
    "   讀墨可能改用新的欄位攜帶 bookId。請更新 REAL_ID_PATTERN，並在提交 fixture 前人工確認。",
  );
}

function generateMockHtml(libraryHtml: string, meHtml: string): string {
  // Sanitize: replace real user data with mock data
  const sanitizedLibrary = sanitizeLibraryHtml(libraryHtml);
  // The me panel can carry an avatar, whose src/alt are just as personal as the
  // cover art — run it through the same image sanitizer before scrubbing text.
  const sanitizedMe = sanitizeLibraryImages(meHtml)
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, "test-user@readmoo.com")
    .replace(
      /(font-size:\s*16px[^>]*>)\s*[^<]+/i,
      "$1\n      測試使用者\n    ",
    );

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <title>Readmoo 讀墨電子書</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    /* 新站為 .openbook-overlay；.openbook 保留以相容舊 fixture */
    .library-item .openbook-overlay,
    .library-item .openbook { display: none; }
    .library-item:hover .openbook-overlay,
    .library-item:hover .openbook { display: block; }
    .library-item .privacy { display: none; }
    #library-view, #me-view { display: none; }
  </style>
</head>
<body>
  <!-- 書庫頁面 (#/library) -->
  <div id="library-view">
${sanitizedLibrary}

${SHORT_ID_GUARD_CARD}

${LEGACY_GUARD_CARD}
  </div>

  <!-- 個人資料頁面 (#/me) -->
  <div id="me-view">
    ${sanitizedMe}
  </div>

  <script>
    // SPA 路由：根據 hash 顯示對應頁面
    function showCurrentView() {
      var hash = location.hash || "#/library";
      var libraryView = document.getElementById("library-view");
      var meView = document.getElementById("me-view");

      if (hash.indexOf("/me") !== -1) {
        libraryView.style.display = "none";
        meView.style.display = "block";
      } else {
        libraryView.style.display = "block";
        meView.style.display = "none";
      }
    }

    if (!location.hash) {
      location.hash = "#/library";
    }
    showCurrentView();

    window.addEventListener("hashchange", showCurrentView);

    // 模擬 hover 觸發操作區顯示（新站 .openbook-overlay / 舊站 .openbook）
    document.querySelectorAll(".library-item").forEach(function(item) {
      item.querySelectorAll(".openbook-overlay, .openbook").forEach(function(overlay) {
        item.addEventListener("mouseenter", function() {
          overlay.style.display = "block";
          // 新站在 inline style 上用 opacity/pointer-events 隱藏操作區
          overlay.style.opacity = "1";
          overlay.style.pointerEvents = "auto";
        });
      });
    });
  </script>
</body>
</html>
`;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error("錯誤:", err);
    process.exit(1);
  });
