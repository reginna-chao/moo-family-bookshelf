/**
 * Verify that scraper.ts selectors still match Readmoo's live DOM.
 *
 * Uses your local Chrome profile (already logged into Readmoo) to:
 * 1. Check all selectors used by scraper.ts against the real page
 * 2. Optionally generate an updated mock-readmoo.html from live DOM
 *
 * Usage:
 *   pnpm verify:selectors                  # check only
 *   pnpm verify:selectors -- --update-mock # check + regenerate mock HTML
 *
 * Prerequisites:
 *   - Close all Chrome windows before running (Chrome locks the profile)
 *   - Be logged into Readmoo in your default Chrome profile
 *   - Have at least 1 book in your library
 */

import { chromium } from "@playwright/test";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_OUTPUT = resolve(__dirname, "..", "tests", "e2e", "fixtures", "mock-readmoo.html");

const READMOO_LIBRARY = "https://read.readmoo.com/#/library";
const READMOO_ME = "https://read.readmoo.com/#/me";

// All selectors used by scraper.ts, grouped by page
const LIBRARY_SELECTORS = [
  { selector: ".library-item", description: "書籍容器", required: true },
  { selector: ".library-item .info .title[title]", description: "書名（title 屬性）", required: true },
  { selector: ".library-item .cover-img[src]", description: "封面圖片", required: true },
  { selector: ".library-item .openbook", description: "hover 後的操作區", required: true },
  { selector: ".library-item .openbook a.reader-link[href]", description: "閱讀連結（含 bookId）", required: true },
  { selector: ".library-item .privacy[id^='privacy-']", description: "fallback bookId", required: false },
  { selector: ".desktop-top-nav-btn", description: "頂部導覽列按鈕", required: false },
] as const;

const ME_SELECTORS = [
  { selector: ".me-panel", description: "個人資料面板", required: true },
  { selector: ".me-panel div[style*='font-size: 16px']", description: "顯示名稱", required: true },
] as const;

interface CheckResult {
  selector: string;
  description: string;
  required: boolean;
  found: boolean;
  count: number;
  sample?: string;
}

function getChromeUserDataDir(): string {
  const platform = process.platform;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (platform === "win32") {
    return resolve(process.env.LOCALAPPDATA || resolve(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  }
  if (platform === "darwin") {
    return resolve(home, "Library", "Application Support", "Google", "Chrome");
  }
  return resolve(home, ".config", "google-chrome");
}

async function main() {
  const updateMock = process.argv.includes("--update-mock");

  console.log("=== Readmoo 選擇器驗證工具 ===\n");

  // Use a dedicated profile directory — avoids locking issues with your main Chrome
  // First run: you'll need to log into Readmoo manually. Cookie persists for future runs.
  const profileDir = resolve(__dirname, "..", ".verify-selectors-profile");
  console.log(`Profile 目錄: ${profileDir}`);
  console.log("（首次執行請在開啟的 Chrome 中登入讀墨，登入後腳本會自動繼續）\n");

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

  const page = context.pages()[0] || await context.newPage();
  const allResults: CheckResult[] = [];
  let libraryHtml = "";
  let meHtml = "";

  try {
    // --- Check library page ---
    console.log("📖 正在載入書櫃頁面...");
    await page.goto(READMOO_LIBRARY, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Wait for SPA to render book items
    const libraryItem = page.locator(".library-item").first();
    let foundBooks = await libraryItem.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);

    if (!foundBooks) {
      // Likely not logged in — wait for user to log in manually
      console.log("\n⚠️  未偵測到書籍。請在 Chrome 中登入讀墨，登入後會自動繼續...");
      console.log("   （登入後請導航到書櫃頁面：read.readmoo.com/#/library）\n");
      await libraryItem.waitFor({ state: "visible", timeout: 300_000 }); // 5 min to log in
      foundBooks = true;
      console.log("✅ 偵測到書籍，繼續驗證...\n");
    }

    // Trigger hover on first item to reveal .openbook
    const firstItem = page.locator(".library-item").first();
    if (await firstItem.isVisible()) {
      await firstItem.hover();
      await page.waitForTimeout(500);
    }

    console.log("\n--- 書櫃頁面選擇器 ---\n");

    for (const { selector, description, required } of LIBRARY_SELECTORS) {
      const count = await page.locator(selector).count();
      const found = count > 0;
      let sample: string | undefined;

      if (found) {
        const el = page.locator(selector).first();
        if (selector.includes("[title]")) {
          sample = await el.getAttribute("title") ?? undefined;
        } else if (selector.includes("[src]")) {
          sample = await el.getAttribute("src") ?? undefined;
        } else if (selector.includes("[href]")) {
          sample = await el.getAttribute("href") ?? undefined;
        } else if (selector.includes("[id^=")) {
          sample = await el.getAttribute("id") ?? undefined;
        }
      }

      const icon = found ? "✅" : required ? "❌" : "⚠️";
      const countStr = found ? `(${count} 個)` : "";
      const sampleStr = sample ? ` → ${sample}` : "";
      console.log(`  ${icon} ${selector} — ${description} ${countStr}${sampleStr}`);

      allResults.push({ selector, description, required, found, count, sample });
    }

    // Capture library HTML for mock generation
    if (updateMock) {
      const items = page.locator(".library-item");
      const itemCount = await items.count();
      const maxItems = Math.min(itemCount, 5);
      const fragments: string[] = [];

      for (let i = 0; i < maxItems; i++) {
        // Trigger hover to reveal .openbook
        await items.nth(i).hover();
        await page.waitForTimeout(300);
        const html = await items.nth(i).evaluate((el) => el.outerHTML);
        fragments.push(html);
      }

      // Also check for borrowed books
      const borrowedCount = await page.locator('.library-item [type="borrowed"]').count();

      // Get the nav bar
      const navBar = page.locator(".desktop-top-nav-btn").first();
      const navBarHtml = await navBar.isVisible()
        ? await navBar.evaluate((el) => el.parentElement?.outerHTML ?? "")
        : "";

      libraryHtml = `${navBarHtml}\n\n${fragments.map((f, i) => `    <!-- 書籍 ${i + 1} -->\n    ${f}`).join("\n\n")}`;

      if (borrowedCount > 0) {
        console.log(`\n  ℹ️  發現 ${borrowedCount} 本借入書籍`);
      }
    }

    // --- Check profile page ---
    console.log("\n📋 正在載入個人頁面...");
    await page.goto(READMOO_ME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator(".me-panel").waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      console.log("⚠️  未找到 .me-panel，頁面可能未登入");
    });

    console.log("\n--- 個人頁面選擇器 ---\n");

    for (const { selector, description, required } of ME_SELECTORS) {
      const count = await page.locator(selector).count();
      const found = count > 0;
      let sample: string | undefined;

      if (found) {
        sample = (await page.locator(selector).first().textContent())?.trim();
      }

      const icon = found ? "✅" : required ? "❌" : "⚠️";
      const sampleStr = sample ? ` → "${sample}"` : "";
      console.log(`  ${icon} ${selector} — ${description}${sampleStr}`);

      allResults.push({ selector, description, required, found, count, sample });
    }

    // Check email detection (special logic in scraper)
    const emailFound = await page.evaluate(() => {
      const panel = document.querySelector(".me-panel");
      if (!panel) return null;
      const candidates = panel.querySelectorAll<HTMLElement>("div[style]");
      for (const el of candidates) {
        if (el.childElementCount > 0) continue;
        const text = el.textContent?.trim() ?? "";
        if (text.includes("@") && text.includes(".")) return text;
      }
      return null;
    });

    const emailIcon = emailFound ? "✅" : "❌";
    console.log(`  ${emailIcon} Email 偵測邏輯 — div[style] 含 @ 和 .${emailFound ? ` → "${emailFound}"` : ""}`);

    if (updateMock) {
      const mePanel = page.locator(".me-panel");
      meHtml = await mePanel.isVisible()
        ? await mePanel.evaluate((el) => el.outerHTML)
        : "";
    }

    // --- Summary ---
    const failed = allResults.filter((r) => r.required && !r.found);
    const warnings = allResults.filter((r) => !r.required && !r.found);

    console.log("\n=== 結果 ===\n");

    if (failed.length === 0) {
      console.log("✅ 所有必要選擇器都存在，scraper.ts 與讀墨 DOM 相容。");
    } else {
      console.log(`❌ ${failed.length} 個必要選擇器失效：`);
      for (const f of failed) {
        console.log(`   - ${f.selector} (${f.description})`);
      }
      console.log("\n   → 需要更新 scraper.ts 和 mock HTML");
    }

    if (warnings.length > 0) {
      console.log(`\n⚠️  ${warnings.length} 個非必要選擇器未找到（可能正常）：`);
      for (const w of warnings) {
        console.log(`   - ${w.selector} (${w.description})`);
      }
    }

    // --- Generate mock HTML ---
    if (updateMock && failed.length === 0) {
      console.log("\n📝 正在產生 mock-readmoo.html...");
      const mockContent = generateMockHtml(libraryHtml, meHtml);
      writeFileSync(MOCK_OUTPUT, mockContent, "utf-8");
      console.log(`✅ 已寫入 ${MOCK_OUTPUT}`);
    } else if (updateMock && failed.length > 0) {
      console.log("\n⚠️  有選擇器失效，跳過 mock 產生。請先更新 scraper.ts。");
    }
  } finally {
    await context.close();
  }
}

function generateMockHtml(libraryHtml: string, meHtml: string): string {
  // Sanitize: replace real user data with mock data
  const sanitizedMe = meHtml
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, "test-user@readmoo.com")
    .replace(/(font-size:\s*16px[^>]*>)\s*[^<]+/i, "$1\n      測試使用者\n    ");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <title>Readmoo 讀墨電子書</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .library-item .openbook { display: none; }
    .library-item:hover .openbook { display: block; }
    .library-item .privacy { display: none; }
    #library-view, #me-view { display: none; }
  </style>
</head>
<body>
  <!-- 書庫頁面 (#/library) -->
  <div id="library-view">
${libraryHtml}
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

    // 模擬 hover 觸發 openbook 顯示
    document.querySelectorAll(".library-item").forEach(function(item) {
      item.addEventListener("mouseenter", function() {
        var openbook = item.querySelector(".openbook");
        if (openbook) {
          openbook.style.display = "block";
        }
      });
    });
  </script>
</body>
</html>
`;
}

main().catch((err) => {
  console.error("錯誤:", err);
  process.exit(1);
});
