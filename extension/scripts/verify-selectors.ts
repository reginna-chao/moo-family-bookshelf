/** Check Readmoo's selectors and filter / search / lend flows on the live new + legacy site; `--update-mock`
 *  regenerates the fixture. Usage, exit code, `--break`: .claude/rules/test.md → E2E tooling (extension/scripts). */

import { chromium, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  PROFILE_DISPLAY_NAME_STYLE,
  READMOO_SELECTORS,
} from "moo-family-bookshelf-shared/config/readmoo";
import {
  buildSpecs,
  type CheckResult,
  type SelectorKey,
  type SelectorMap,
  type SelectorSpecs,
} from "./verify-selectors-specs";
import {
  NAV_OPTIONS,
  SITES,
  checkSelectors,
  waitForLibrary,
  type Site,
} from "./verify-selectors-page";
import {
  checkArchiveFlow,
  checkLendFlow,
  checkSearchFlow,
} from "./verify-selectors-flows";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_OUTPUT = resolve(
  __dirname,
  "..",
  "tests",
  "e2e",
  "fixtures",
  "mock-readmoo.html",
);

const ITEM = READMOO_SELECTORS.libraryItem;

/** The selector map and check lists of one run; `--break` swaps one selector in both. */
interface RunInput {
  selectors: SelectorMap;
  specs: SelectorSpecs;
}

interface SiteReport {
  site: Site;
  /** False when the library never rendered (logged out / empty account). */
  reachable: boolean;
  results: CheckResult[];
  libraryHtml: string;
  meHtml: string;
}

const BREAK_FLAG = "--break=";

function isSelectorKey(key: string): key is SelectorKey {
  return Object.prototype.hasOwnProperty.call(READMOO_SELECTORS, key);
}

/** The selectors to check: `READMOO_SELECTORS`, or (dev-only `--break=<key>`) an in-memory copy with
 *  that key replaced so the run proves the breakage is reported; null for an unknown key. */
function selectorsForRun(argv: readonly string[]): SelectorMap | null {
  const flag = argv.find((arg) => arg.startsWith(BREAK_FLAG));
  if (!flag) return READMOO_SELECTORS;
  const key = flag.slice(BREAK_FLAG.length);
  if (!isSelectorKey(key)) return null;
  const broken = `.moo-verify-break-${key}`;
  console.log(
    `🧪 --break：${key} 改成 ${broken}（只在這次執行的記憶體中，不改任何檔案）\n`,
  );
  return { ...READMOO_SELECTORS, [key]: broken };
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
async function checkEmailHeuristic(
  page: Page,
  selectors: SelectorMap,
): Promise<void> {
  const emailFound = await page.evaluate(
    ([panelSelector, leafSelector]) => {
      const panel = document.querySelector(panelSelector);
      if (!panel) return null;
      const candidates = panel.querySelectorAll<HTMLElement>(leafSelector);
      for (const el of candidates) {
        if (el.childElementCount > 0) continue;
        const text = el.textContent?.trim() ?? "";
        if (text.includes("@") && text.includes(".")) return text;
      }
      return null;
    },
    [selectors.mePanel, selectors.profileStyledLeaf] as const,
  );

  console.log(
    `  ${emailFound ? "✅" : "❌"} Email 偵測邏輯 — ${selectors.profileStyledLeaf} 含 @ 和 .${
      emailFound ? ` → "${emailFound}"` : ""
    }`,
  );
}

async function checkLibraryPage(
  page: Page,
  site: Site,
  run: RunInput,
  captureHtml: boolean,
): Promise<{ reachable: boolean; results: CheckResult[]; html: string }> {
  console.log(`\n📖 [${site.label}] 正在載入書櫃頁面 ${site.libraryUrl} ...`);
  await page.goto(site.libraryUrl, NAV_OPTIONS);

  const reachable = await waitForLibrary(page, site);
  if (!reachable) return { reachable, results: [], html: "" };

  // Hover the first item so the overlay layer renders before we query it.
  const firstItem = page.locator(ITEM).first();
  if (await firstItem.isVisible()) {
    await firstItem.hover();
    await page.waitForTimeout(500);
  }

  console.log(`\n--- [${site.label}] 書櫃頁面選擇器 ---\n`);
  const results = await checkSelectors(
    page,
    run.specs.LIBRARY_SELECTORS,
    site,
    "attr",
  );
  const html = captureHtml ? await captureLibraryHtml(page) : "";
  return { reachable, results, html };
}

/** The interactive filter → search → lend checks; each one reloads the library when done. */
async function checkFlows(
  page: Page,
  site: Site,
  { selectors, specs }: RunInput,
): Promise<CheckResult[]> {
  const archive = await checkArchiveFlow(
    page,
    site,
    selectors,
    specs.ARCHIVE_FLOW_SELECTORS,
  );
  const search = await checkSearchFlow(
    page,
    site,
    selectors,
    specs.SEARCH_FLOW_SELECTORS,
  );
  const lend = await checkLendFlow(
    page,
    site,
    selectors,
    specs.LEND_FLOW_SELECTORS,
  );
  return [...archive, ...search, ...lend];
}

async function checkMePage(
  page: Page,
  site: Site,
  run: RunInput,
  captureHtml: boolean,
): Promise<{ results: CheckResult[]; html: string }> {
  console.log(`\n📋 [${site.label}] 正在載入個人頁面 ${site.meUrl} ...`);
  await page.goto(site.meUrl, NAV_OPTIONS);
  await page
    .locator(READMOO_SELECTORS.mePanel)
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {
      console.log(`⚠️  未找到 ${READMOO_SELECTORS.mePanel}，頁面可能未登入`);
    });

  console.log(`\n--- [${site.label}] 個人頁面選擇器 ---\n`);
  const results = await checkSelectors(
    page,
    run.specs.ME_SELECTORS,
    site,
    "text",
  );
  await checkEmailHeuristic(page, run.selectors);

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
  run: RunInput,
  captureHtml: boolean,
): Promise<SiteReport> {
  console.log(`\n${"=".repeat(50)}\n=== ${site.label} ===\n${"=".repeat(50)}`);

  const library = await checkLibraryPage(page, site, run, captureHtml);
  if (!library.reachable) {
    return {
      site,
      reachable: false,
      results: [],
      libraryHtml: "",
      meHtml: "",
    };
  }

  const flows = await checkFlows(page, site, run);
  const me = await checkMePage(page, site, run, captureHtml);
  return {
    site,
    reachable: true,
    results: [...library.results, ...flows, ...me.results],
    libraryHtml: library.html,
    meHtml: me.html,
  };
}

/** Required checks that ran and failed; a check that could not run (`skippedReason`) is never one. */
function failuresOf(report: SiteReport): CheckResult[] {
  return report.results.filter(
    (r) => r.required && !r.found && r.skippedReason === undefined,
  );
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
    (r) =>
      r.applicable && !r.required && !r.found && r.skippedReason === undefined,
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
  printSkipped(report);
}

/** List the checks that could not run, with the reason; they never affect the exit code or the mock. */
function printSkipped(report: SiteReport): void {
  const skipped = report.results.filter(
    (r) => r.applicable && r.skippedReason !== undefined,
  );
  if (skipped.length === 0) return;
  console.log(`ℹ️  ${skipped.length} 個檢查無法執行：`);
  for (const s of skipped) {
    console.log(`   - ${s.selector} (${s.description})：${s.skippedReason}`);
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
    console.log(
      "\n   → 需要更新 shared/src/config/readmooSelectors.ts 和 mock HTML",
    );
  }
  return exitCode;
}

/** Read the command line; null (exit 2) for an unknown `--break` key. A `--break` run never writes the mock. */
function parseArgs(
  argv: readonly string[],
): { run: RunInput; updateMock: boolean } | null {
  const selectors = selectorsForRun(argv);
  if (!selectors) {
    console.error(
      `❌ --break 的 key 不存在。可用的 key：\n   ${Object.keys(READMOO_SELECTORS).join("\n   ")}`,
    );
    return null;
  }
  const breaking = selectors !== READMOO_SELECTORS;
  const wantsMock = argv.includes("--update-mock");
  if (breaking && wantsMock) {
    console.log("⚠️  使用 --break 時不會產生 mock，已忽略 --update-mock。\n");
  }
  const run = { selectors, specs: buildSpecs(selectors) };
  return { run, updateMock: wantsMock && !breaking };
}

async function main(): Promise<number> {
  console.log("=== Readmoo 選擇器驗證工具（新站 + 舊站）===\n");

  const args = parseArgs(process.argv);
  if (!args) return 2;
  const { run, updateMock } = args;

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
      reports.push(await runSite(page, site, run, updateMock && site.primary));
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
      "\n⚠️  新站選擇器未全數通過，跳過 mock 產生。請先更新 shared/src/config/readmooSelectors.ts。",
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The display-name element and its text, built from the same style string as `profileDisplayName`
 *  (any whitespace after the colon, as before). */
const DISPLAY_NAME_PATTERN = new RegExp(
  "(" +
    escapeRegExp(PROFILE_DISPLAY_NAME_STYLE).replace(": ", ":\\s*") +
    "[^>]*>)\\s*[^<]+",
  "i",
);

function generateMockHtml(libraryHtml: string, meHtml: string): string {
  // Sanitize: replace real user data with mock data
  const sanitizedLibrary = sanitizeLibraryHtml(libraryHtml);
  // The me panel can carry an avatar, whose src/alt are just as personal as the
  // cover art — run it through the same image sanitizer before scrubbing text.
  const sanitizedMe = sanitizeLibraryImages(meHtml)
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, "test-user@readmoo.com")
    .replace(DISPLAY_NAME_PATTERN, "$1\n      測試使用者\n    ");

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
