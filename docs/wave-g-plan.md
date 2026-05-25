# Wave G 開發計畫 — 書籍分頁讀取 + 顯示量控制

> **來源**：`docs/project-plan.md:798-816`
> **建立日期**：2026-05-22
> **參與角色**：team-lead → fe-team-lead（mode B / Checkpoint）
> **狀態**：Phase 1 完成、所有決策（Q-A 到 Q-G）user 已確認 — 可直接派 `/fe-coder` 進 Phase 2 Subtask 1

---

## 接續開發指引（換電腦後讀我）

1. 完整閱讀本文檔（重點看 [§5 決策記錄](#5-決策記錄user-已確認-2026-05-22) 知道 Q-A 到 Q-G 的最終答案）
2. 新 chat 輸入：

   ```
   /fe-team-lead B 依照 docs/wave-g-plan.md 開發 Wave G。
   Q-A 到 Q-G 與 A1–A7 假設均已 user 確認（見 §5），請直接進 Phase 2 從 Subtask 1 開始。
   ```
3. fe-team-lead 進 Phase 2，依 [§6 Subtask 拆分](#6-subtask-拆分串行-1--2--3) 逐項派 coder/tester/review
4. 跨團隊驗證與 commit 由 team-lead 結尾收口

---

## 1. 背景與根因

使用者回報「按下儲存後桌電主機轟轟轟運作」（風扇狂響）— 根因是 1000 本書 row + 書封 `<img>` 全部在 DOM 內，儲存只是引爆 re-render / repaint。

**Wave G 解法**：
1. 移除讀墨爬取 200 本上限（讀墨頁面是 window 級 infinite scroll，捲到底觸發下一批 200 本）
2. 顯示層改用 Load More（預設首 100，每按 +100）— **直接砍 DOM 數量**，同時解掉瀏覽與儲存兩個卡頓
3. 書封 `<img>` 加 `loading="lazy"` + `decoding="async"` + spinner placeholder + 淡入過渡

**重要前提（已確認）**：
- 後端 API、KV、Worker **完全不動**。前端一次取得完整書單，UI 自己分頁顯示。
- 搜尋 / Status Filter / Category Filter / 成員 Dropdown 全部作用於**完整書單**，匹配結果直接全部顯示。
- KV 容量足夠（25MB ÷ 500B = 5 萬本），plan 已說明無需後端分頁。

**version bump 暫不處理**，之後另跑 `/bump-ver`。

---

## 2. team-lead Phase 1 — 任務拆解與假設（已 user 確認）

### 2.1 純前端任務（無 Phase 2 API 契約）

派 1 支 `/fe-team-lead B`，3 個 subtask 串行。Worker / KV / API 契約完全不動。

### 2.2 已確認的決策

| 編號 | 問題 | 採用方案 |
|------|------|---------|
| **Q1** | 讀墨「下一頁」機制？ | 已實測：window 級 infinite scroll，捲到底觸發載入下一批 200 本，5 秒體感間隔，直到沒有更多。DOM 結構觀察詳見 [§10](#10-readmoo-頁面-dom-結構觀察)。 |
| **Q2** | 大量書籍下，scrape 時要邊爬邊存還是全部成功才存？ | **全部成功才存（atomic）**。中途 dialog 關閉 → 丟棄並可重試。 |
| **Q3** | LoadingOverlay 進度文案？ | 「正在讀取第 N 頁，已收集 X 本…」— 不顯示總頁數（無法估算）。`LoadingOverlay` 元件本身不擴充 props，仍是 `{ message: string }`，呼叫端動態傳新字串。 |
| **Q4** | Load More button 視覺？ | button + 「載入更多（已顯示 X / 共 Y 本）」；當 `visibleCount >= filtered.length` 隱藏；當縮窄類 filter 啟用時隱藏（強制全顯示）。 |
| **Q5** | Reset visibleCount 回 100 的時機？ | 切 tab、切成員、重新打開 Dialog；**不**因搜尋/Filter 變動 reset；**不**持久化捲動位置。 |
| **Q6** | Hard cap | 100 批（20,000 本理論上限）、單批等待 10 秒 timeout，純防呆。`scrollTo` 後 10 秒沒新書 = 「沒有更多」，**不**算錯誤。 |
| **版本 bump** | | 跳過，之後另跑 `/bump-ver`。 |

### 2.3 爬取策略（已確認）

```
1. await requestFiberData()                    // 沿用既有
2. let prevCount = -1, page = 1, HARD_CAP = 100
3. while page <= HARD_CAP:
     count = document.querySelectorAll('.library-item').length
     if count === prevCount → break (沒有更多)
     prevCount = count
     window.scrollTo(0, document.documentElement.scrollHeight)
     await waitForNewItems(currentCount=count, timeoutMs=10000)
       // count 增加即 resolve；10s 內無變化即 resolve（視為沒有更多）
     onProgress?.(page, newCount)               // 更新 LoadingOverlay
     page++
4. 完成 → 對所有 .library-item 跑既有 scrapeItem flow
5. finally: window.scrollTo(0, originalScrollY) // 還原使用者捲動位置
```

---

## 3. fe-team-lead Phase 1 — 細部分析與 Gap 識別

### 3.1 既有現況關鍵發現（補 team-lead 沒提到的）

| # | 觀察 | 對 Subtask 的影響 |
|---|------|------------------|
| **O1** | `LoadingOverlay` 目前**只在 [`extension/src/dialog/Onboarding.tsx:138`](../extension/src/dialog/Onboarding.tsx#L138) 被使用**。`useAutoSetup.phaseMessage` 是靜態常數 record（[`extension/src/dialog/useAutoSetup.ts:13-19`](../extension/src/dialog/useAutoSetup.ts#L13-L19)），不支援動態文字。 | Subtask 1 必須改造 `phaseMessage`：在 `scraping-books` phase 時優先回傳一個 dynamic `progressMessage` state。 |
| **O2** | `useBookSync`（manual sync / auto-sync 入口）**沒有 LoadingOverlay**，只在 PersonalShelf 內把按鈕文字改成「同步中...」（[`extension/src/dialog/PersonalShelf.tsx:136`](../extension/src/dialog/PersonalShelf.tsx#L136)）。1000 本書 × 5 秒/批 ≈ 25 秒 manual sync，使用者會以為當機。 | **這是 team-lead 沒考慮的點**，見 Q-A。 |
| **O3** | 書封 fallback 各檔案行為不一：BookRow 用純色 div、BookCard **完全無 fallback**、PWA 兩 ShelfPage 用 `<BookOpen>` icon。 | LazyCover 設計需 `fallback` slot prop，各檔案自行決定 fallback 樣式 —— **不統一視覺**，只統一 lazy load + spinner 載入過程。 |
| **O4** | `useSearch.isFiltering` 只反映 search term，**不包含** StatusFilter / CategoryFilter / MemberDropdown / ArchiveView 是否啟用。 | Subtask 2 的「filter 啟用 → 強制全顯示」邏輯需要明確定義，見 Q-B。 |
| **O5** | `MemberDropdown` 預設值是 `"all-except-self"`（不是 `"all"`），切成員時已會 `resetSearch()`（[`extension/src/dialog/FamilyShelf.tsx:73`](../extension/src/dialog/FamilyShelf.tsx#L73)）。 | Subtask 2 的 reset 觸發點：「切成員時 visibleCount reset」可以掛在既有 `handleMemberFilterChange` 內。 |
| **O6** | [`extension/src/dialog/PersonalShelf.tsx`](../extension/src/dialog/PersonalShelf.tsx) 232 行（>200 已超標），[`pwa/src/pages/PersonalShelfPage.tsx`](../pwa/src/pages/PersonalShelfPage.tsx) 396 行（嚴重超標）。 | Subtask 2 **必抽 `useLoadMore` hook**（Extension + PWA 各一份）；否則檔案會繼續膨脹，違反 frontend.md 200 行規則。 |
| **O7** | BookCard 的 `<img>` 被 `<a href>` 包住（[`extension/src/dialog/BookCard.tsx:62-72`](../extension/src/dialog/BookCard.tsx#L62-L72)），LazyCover 元件不能影響 `<a>` 包覆結構。 | Subtask 3 元件設計：`<LazyCover>` 只負責 img + placeholder，不包 `<a>`。 |
| **O8** | BookRow 已是 `React.memo`，BookCard **未 memo**。 | Wave G 不主動加 memo（那是 Wave K #25）。但 LazyCover 自身應該 `React.memo`，避免父層 re-render 時誤觸 spinner 重置。 |

### 3.2 假設清單

- **A1**：MutationObserver vs polling — 採 **polling 500ms**（與既有 [`scraper-archive.ts:67-93`](../extension/src/content/scraper-archive.ts#L67-L93) `waitForLibraryReload` 一致風格、跨 jsdom 測試環境更穩）
- **A2**：jsdom 測試環境沒有 `scrollHeight`/`scrollTo` — `scrapeBooks` 應 graceful degrade（若 scroll 後 polling timeout 達到，視為「沒有更多」並繼續，不丟錯）
- **A3**：LazyCover **不嘗試**載入空字串 src — `src === ""` 時直接 render `fallback` prop 內容，跳過 img 與 spinner
- **A4**：LazyCover spinner 樣式直接複用 `moo-spin` keyframe，但放在自身 component scope（小型 inline `<style>` 或外部 CSS）— **不依賴** LoadingOverlay 必須存在於同一個 mount 樹
- **A5**：Subtask 1 的 `progressMessage` 在 `scraping-books` 階段才有意義；其他 phase 仍回傳靜態文字
- **A6**：Hard cap 達上限 = `console.warn` 並結束 scrape（**不**丟錯、**不**回報為 error）
- **A7**：scrapeBooks 改造後**對外簽名仍向後相容**：`onProgress` 是 optional。沒傳就只有分頁 loop，沒進度回報。

---

## 4. Security / Performance / Lifecycle 檢查

- **無新 API、無新 token、無新 polling 跨 lifecycle**：scroll loop 只在 scrape 期間活躍，10s/批、hard cap 100 批，最壞 1000 秒結束
- **無背景 timer / 無 setInterval 跨頁面**：scrape 是使用者主動觸發
- **`window.scrollTo` 對 Readmoo 頁面是合法操作**：與使用者真的捲動行為相同
- **書封 lazy load → 正向降載**：viewport 外的 img 不發 request、不解碼
- **LazyCover memo 化** → toggle 一本書時只該 row 重新 render，不會觸發鄰近 row 的 spinner reset
- **Worker req/day**：完全不變

---

## 5. 決策記錄（user 已確認 2026-05-22）

| 編號 | 問題 | 最終決策 |
|------|------|---------|
| **Q-A** | `useBookSync`（manual sync / auto-sync）要不要顯示分頁進度？1000 本書約 25 秒，否則使用者看「同步中」會以為當機。 | **選項 A**：useBookSync 加 `progressMessage` state，PersonalShelf 在按鈕下方顯示一行小字「正在讀取第 N 頁，已收集 X 本…」（不擋 UI、有進度感、改動最小，auto-sync 也適用） |
| **Q-B** | 「filter 啟用 → 強制全顯示」的具體判定？ | **二分法**：<br>**縮窄類**（強制全顯示，隱藏 Load More button）：search 非空、`statusFilter !== "all"`、`categoryFilter !== ""`<br>**視角切換類**（reset visibleCount 回 100，仍套 Load More）：`filterMember` 切換、`archiveView` 切換、tab 切換 |
| **Q-C** | visibleCount 在「強制全顯示」與「未啟用 filter」之間切換時的記憶行為？ | **回到預設 100**（user 決策，覆寫 fe-TL 原本「保留 300」傾向）。例：使用者按到 300 → 搜尋（強制全顯示 50） → 清空搜尋 → 視作「視角切換」回到首 100。實作：當縮窄類 filter 由啟用變停用，visibleCount 重置為 100。 |
| **Q-D** | PWA 是否需要 Load More 進度文字？ | **不需要**。PWA 沒有 scraper，book sync 是「從 server fetch 完整 user.books」— 通常 < 1 秒。 |
| **Q-E** | LazyCover spinner 樣式：保留 placeholder icon 嗎？ | **選項 X**：載入中 = spinner，載入失敗 = fallback prop（PWA 仍是 BookOpen icon、Extension BookRow 仍是純色 div、BookCard 仍是純色 `#f1f5f9`）。Plan 明確寫「中央 spinner」。 |
| **Q-F** | `window.scrollTo` 後是否需要把 scroll 位置還原？ | **還原到原本位置**。`scrapeBooks` 開始記 `originalScrollY = window.scrollY`，`finally` 區塊 `window.scrollTo(0, originalScrollY)`。沿用 [`extension/src/dialog/useAutoSetup.ts:76`](../extension/src/dialog/useAutoSetup.ts#L76) `originalHashRef` 模式。 |
| **Q-G** | Hard cap 達上限要 log 還是 silent？ | `console.warn`（記入 chrome devtools）+ 結束 scrape，**不**丟錯給 UI。 |

**A1–A7 假設**：均 user 確認，照走。

**Subtask 串行 1 → 2 → 3**：確認。

---

## 6. Subtask 拆分（串行 1 → 2 → 3）

**串行而非並行**：Subtask 2、3 都會碰 BookRow / BookCard，避免 merge conflict。每個 subtask 走完整 `fe-coder → fe-tester → fe-review → fix cycle`。

### 6.1 Subtask 1 — Content Script 分頁爬取 + 進度回報

**Coder 動到**：
- [`extension/src/content/scraper.ts`](../extension/src/content/scraper.ts) — `scrapeBooks(opts?: { onProgress? })` 加分頁 loop
- [`extension/src/content/scraper-archive.ts`](../extension/src/content/scraper-archive.ts) — 透過 import 自動沿用，但呼叫 `scrapeBooks` 時要傳 onProgress（可選）
- [`extension/src/dialog/useAutoSetup.ts`](../extension/src/dialog/useAutoSetup.ts) — `phaseMessage` 改成動態（state `progressMessage` 優先），把 onProgress 串接過來
- [`extension/src/dialog/useBookSync.ts`](../extension/src/dialog/useBookSync.ts) — 加 `progressMessage` state（**僅 Q-A 選項 A 採納時**）
- [`extension/src/dialog/PersonalShelf.tsx`](../extension/src/dialog/PersonalShelf.tsx) — 顯示 `progressMessage` 於按鈕下方（**僅 Q-A 選項 A 採納時**）

**Tester 動到**：
- 新增 `extension/tests/unit/content/scraper.pagination.test.ts` — mock document API、scrollHeight、querySelectorAll 計數變化、驗證 loop 終止 / hard cap / timeout / onProgress callback
- 更新 `extension/tests/component/Onboarding.test.tsx`（如存在）— 驗證 progressMessage 流到 LoadingOverlay
- 新增/更新 `extension/tests/unit/dialog/useBookSync.test.ts`（**僅 Q-A 選項 A 採納時**）

### 6.2 Subtask 2 — Load More UI + useLoadMore hook

**Coder 動到**：
- 新增 `extension/src/dialog/useLoadMore.ts` — hook 簽名 `{ items, pageSize=100, narrowingActive }` → `{ visibleItems, hasMore, loadMore, reset }`
- 新增 `pwa/src/hooks/useLoadMore.ts` — 同邏輯獨立一份
- 更新 [`extension/src/dialog/PersonalShelf.tsx`](../extension/src/dialog/PersonalShelf.tsx) — 套用 hook、加 Load More button、reset 觸發點
- 更新 [`extension/src/dialog/FamilyShelf.tsx`](../extension/src/dialog/FamilyShelf.tsx) — 同上
- 更新 [`pwa/src/pages/PersonalShelfPage.tsx`](../pwa/src/pages/PersonalShelfPage.tsx) — 同上
- 更新 [`pwa/src/pages/FamilyShelfPage.tsx`](../pwa/src/pages/FamilyShelfPage.tsx) — 同上

**Tester 動到**：
- 新增 `extension/tests/unit/dialog/useLoadMore.test.ts`
- 新增 `pwa/tests/unit/hooks/useLoadMore.test.ts`
- 更新四個 component test 加 Load More button 行為（顯示 / 隱藏、點擊 +100、reset、narrowing 強制全顯示、Q-C 記憶行為）

### 6.3 Subtask 3 — LazyCover 元件

**Coder 動到**：
- 新增 `extension/src/dialog/LazyCover.tsx` — Extension 版
- 新增 `pwa/src/components/LazyCover.tsx` — PWA 版
- 更新 [`extension/src/dialog/BookRow.tsx`](../extension/src/dialog/BookRow.tsx) — 套 LazyCover，fallback prop = 既有純色 div
- 更新 [`extension/src/dialog/BookCard.tsx`](../extension/src/dialog/BookCard.tsx) — 套 LazyCover，fallback prop = 純色（與既有 `background: "#f1f5f9"` 一致）
- 更新 [`pwa/src/pages/PersonalShelfPage.tsx`](../pwa/src/pages/PersonalShelfPage.tsx) — 套 LazyCover，fallback = 既有 `<BookOpen>` icon
- 更新 [`pwa/src/pages/FamilyShelfPage.tsx`](../pwa/src/pages/FamilyShelfPage.tsx) — 同上

**Tester 動到**：
- 新增 `extension/tests/component/LazyCover.test.tsx` — 驗證 loading attribute、placeholder 顯示 / 消失、onError 走 fallback、空字串 src 直接 render fallback、淡入過渡
- 新增 `pwa/tests/component/LazyCover.test.tsx`
- 既有 BookRow / BookCard / PersonalShelfPage / FamilyShelfPage 測試需檢查是否仍能找到 img（selector 可能需更新）

---

## 7. 規範遵循

- **TypeScript 嚴格**，無 `any`
- `BoolFlag` enum 不直接 true/false（本任務沒碰 boolean payload，仍要遵循）
- 函式 < 40 行，檔案 < 200 行（`.claude/rules/frontend.md` 規則）
- 無多餘 comment / docstring
- 使用 BookRow / BookCard / PWA ShelfPage 既有的 fallback img 機制（保留各檔案原本視覺）
- **Fix Cycle 必跑**：coder → typecheck → tester → review → 修 CRITICAL → 報告

---

## 8. 進度狀態

- [x] team-lead Phase 1 — 任務拆解與假設（user 已確認）
- [x] fe-team-lead Phase 1 — 細部分析與 Gap 識別
- [x] user 確認 Q-A 到 Q-G + A1–A7 假設（2026-05-22）
- [ ] **← 卡在這裡：fe-team-lead Phase 2 — Subtask 1（Content Script 分頁爬取）**
- [ ] fe-team-lead Phase 2 — Subtask 2（Load More UI + hook）
- [ ] fe-team-lead Phase 2 — Subtask 3（LazyCover）
- [ ] fe-team-lead Phase 3-4 — Review + Fix Cycle
- [ ] fe-team-lead Phase 5 — Complete + commit
- [ ] fe-team-lead Phase 6 — Security Scan
- [ ] team-lead Phase 4 — 跨團隊驗證
- [ ] team-lead Phase 5 — 最終報告與 commit
- [ ] team-lead Phase 6 — 整體 Security Scan
- [ ] 提交 PR

---

## 9. 參考資料

- 計畫出處：[`docs/project-plan.md:798-816`](project-plan.md)（Wave G 章節）
- 讀墨頁面 DOM 樣本：user 朋友提供之 >200 本帳號真實 HTML，**含敏感 apiKey，已從版本控制移除並加入 `.gitignore`**。觀察結論已內化於 [§10](#10-readmoo-頁面-dom-結構觀察)，不需再參照原檔。
- 相關 Wave：
  - **Wave K**（`docs/project-plan.md:846-862`）— 儲存路徑 re-render 防爆，virtualization 已併入 Wave G #10a Load More，本 Wave 不處理
  - **Wave L**（v1.4）— 書本 PATCH API，本 Wave 不處理
- 規則文件：
  - `.claude/rules/frontend.md` — 前端架構規則
  - `.claude/rules/global.md` — 全域開發規則（含 Lifecycle & Resource Cost 章節）
  - `.claude/rules/test.md` — 測試規則

---

## 10. Readmoo 頁面 DOM 結構觀察

> 來源：user 朋友提供 >200 本帳號之 library 頁面真實 HTML（檔案含 apiKey，**不上 git**）。以下為 grep / 結構分析結論，足以支撐 Subtask 1 實作。

### 10.1 書本元素結構

每本書是一個 `<div class="library-item library-item-grid-view col-lg-2 col-sm-3 col-4" style="z-index: 1;">`，包在容器 `<div class="library-collection">` 內。整批 library 容器位於 `<div class="desktop-page">` 之下。

書本內部 DOM 線索（既有 [`extension/src/content/scraper.ts`](../extension/src/content/scraper.ts) 已會用到）：
- `.privacy[id^="privacy-{bookId}"]` — fallback book ID 來源
- `.openbook a.reader-link[href]` — book ID 主要來源（hover 後出現）
- `.cover-img[src]` — 書封 URL
- `.info .title[title]` — 書名
- `data-moo-book-id` / `data-moo-cover-url` / `data-moo-author` / `data-moo-category` — fiber-bridge 戳上去的快取屬性
- `[type="borrowed"]` — 借入書（要排除，非本人書櫃）

### 10.2 分頁觸發機制（Subtask 1 直接依據）

**重要結論**：
- DOM 內**無**「下一頁」按鈕、**無** sentinel loader、**無** pagination DOM
- `.library-collection` 容器無 `overflow:scroll` 屬性 → **window 級捲動**觸發 XHR 載入下一批
- grep 全檔僅找到 1 個 `library-collection`（純粹是 container），無 sentinel/loader/pagination/load-more/has-more/next-page 等命名的 class
- 唯一 spinner 是 Facebook SDK 的 `fb_dialog_loader_spinner`，與讀墨分頁無關

**user 提供的體感資訊**：捲到頁面最底部 → 讀墨自動讀取下一頁 200 本 → 中間視網路狀況，5 秒體感間隔，直到沒有更多。

**爬取策略對映**（已寫入 [§2.3](#23-爬取策略已確認)）：
```
window.scrollTo(0, document.documentElement.scrollHeight)
→ wait for .library-item count change (polling 500ms, timeout 10s)
→ 若 count 增加：繼續下一輪
→ 若 count 不變 / timeout：視為「沒有更多」，結束
→ finally: window.scrollTo(0, originalScrollY) 還原使用者位置
```

### 10.3 不應依賴的細節

- 不可依賴**固定** 200 本/批 — 讀墨內部分頁規則可能變動，程式用「count 是否變化」判定即可，不要 hardcode 200
- 不可依賴 `.library-collection` 之外的 selector 來計數 — 該 class 是穩定容器
- jsdom 測試環境通常無 `scrollHeight` / `scrollTo` 真實行為 → 測試需 mock 或讓 graceful degrade 走 timeout 路徑（見 A2）
