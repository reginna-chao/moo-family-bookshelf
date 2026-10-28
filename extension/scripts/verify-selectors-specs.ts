/** Selector check lists for verify-selectors.ts — pure data, no Playwright and no side effects, so a unit
 *  test can import `buildSpecs`. See .claude/rules/test.md → E2E tooling (extension/scripts). */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";

export type SiteId = "next" | "legacy";

export type SelectorKey = keyof typeof READMOO_SELECTORS;

/** `READMOO_SELECTORS` with its values widened to `string`, so `--break` can swap one in. */
export type SelectorMap = { readonly [K in SelectorKey]: string };

export interface SelectorSpec {
  selector: string;
  description: string;
  required: boolean;
  /** "both" = expected on every site; otherwise only on the named one. */
  appliesTo: SiteId | "both";
  /** The `READMOO_SELECTORS` keys this check covers (pinned by verifySelectorsCoverage.test.ts). */
  keys: readonly SelectorKey[];
}

export interface CheckResult {
  siteId: SiteId;
  selector: string;
  description: string;
  /** Required *on this site* (spec.required narrowed by applicability). */
  required: boolean;
  applicable: boolean;
  found: boolean;
  count: number;
  sample?: string;
  /** Set when the page could not be brought to the state this check needs; never a failure. */
  skippedReason?: string;
}

export interface SelectorSpecs {
  LIBRARY_SELECTORS: readonly SelectorSpec[];
  ME_SELECTORS: readonly SelectorSpec[];
  ARCHIVE_FLOW_SELECTORS: readonly SelectorSpec[];
  SEARCH_FLOW_SELECTORS: readonly SelectorSpec[];
  LEND_FLOW_SELECTORS: readonly SelectorSpec[];
}

export function resultIcon(r: CheckResult): string {
  if (r.skippedReason !== undefined) return "ℹ️";
  if (!r.applicable) return r.found ? "ℹ️" : "➖";
  if (r.found) return "✅";
  return r.required ? "❌" : "⚠️";
}

/** Library grid + page-ready checks, run once the grid has rendered (the spinner is long hidden). */
function librarySpecs(s: SelectorMap): SelectorSpec[] {
  const item = s.libraryItem;
  return [
    {
      selector: item,
      description: "書籍容器",
      required: true,
      appliesTo: "both",
      keys: ["libraryItem"],
    },
    {
      selector: `${item} ${s.title}`,
      description: "書名（title 屬性）",
      required: true,
      appliesTo: "both",
      keys: ["title"],
    },
    {
      selector: `${item} ${s.coverImg}`,
      description: "封面圖片",
      required: true,
      appliesTo: "both",
      keys: ["coverImg"],
    },
    {
      selector: `${item} ${s.overlay}`,
      description: "hover 後的操作區（新站）",
      required: true,
      appliesTo: "next",
      keys: ["overlay"],
    },
    {
      selector: `${item} ${s.overlayLegacy}`,
      description: "hover 後的操作區（舊站 fallback）",
      required: true,
      appliesTo: "legacy",
      keys: ["overlayLegacy"],
    },
    {
      selector: `${item} ${s.readerLink}`,
      description: "閱讀連結（含 bookId，新站）",
      required: true,
      appliesTo: "next",
      keys: ["readerLink"],
    },
    {
      selector: `${item} ${s.readerLinkLegacy}`,
      description: "閱讀連結（含 bookId，舊站 fallback）",
      required: true,
      appliesTo: "legacy",
      keys: ["readerLinkLegacy"],
    },
    {
      selector: `${item} ${s.privacyId}`,
      description: "fallback bookId",
      required: false,
      appliesTo: "both",
      keys: ["privacyId"],
    },
    {
      selector: s.topNavBtn,
      description: "頂部導覽列按鈕",
      required: false,
      appliesTo: "both",
      keys: ["topNavBtn"],
    },
    {
      selector: s.pageSpinner,
      description: "頁面載入動畫",
      required: true,
      appliesTo: "both",
      keys: ["pageSpinner"],
    },
    {
      selector: s.pageSpinnerHidden,
      description: "載入完成後隱藏的載入動畫（帶 hide）",
      required: true,
      appliesTo: "both",
      keys: ["pageSpinnerHidden"],
    },
    {
      selector: s.libraryRow,
      description: "書籍列（沒有書卡時的讀取起點）",
      required: true,
      appliesTo: "both",
      keys: ["libraryRow"],
    },
  ];
}

function meSpecs(s: SelectorMap): SelectorSpec[] {
  return [
    {
      selector: s.mePanel,
      description: "個人資料面板",
      required: true,
      appliesTo: "both",
      keys: ["mePanel"],
    },
    {
      selector: `${s.mePanel} ${s.profileDisplayName}`,
      description: "顯示名稱",
      required: true,
      appliesTo: "both",
      keys: ["mePanel", "profileDisplayName"],
    },
    {
      selector: `${s.mePanel} ${s.profileStyledLeaf}`,
      description: "帶 inline style 的資料列（Email 偵測來源）",
      required: false,
      appliesTo: "both",
      keys: ["profileStyledLeaf"],
    },
  ];
}

/** Checked with the filter modal open; nothing in it is ever clicked. */
function archiveFlowSpecs(s: SelectorMap): SelectorSpec[] {
  return [
    {
      selector: `${s.topNavBtn} ${s.filterIcon}`,
      description: "篩選按鈕（導覽列的漏斗圖示）",
      required: true,
      appliesTo: "both",
      keys: ["topNavBtn", "filterIcon"],
    },
    {
      selector: s.filterModalOpen,
      description: "篩選視窗（開啟狀態）",
      required: true,
      appliesTo: "both",
      keys: ["filterModalOpen"],
    },
    {
      selector: `${s.filterModalOpen} ${s.archiveFilterOption}`,
      description: "「已封存書籍」選項",
      required: true,
      appliesTo: "both",
      keys: ["archiveFilterOption"],
    },
    {
      selector: s.filterConfirm,
      description: "篩選視窗的「確定」按鈕",
      required: true,
      appliesTo: "both",
      keys: ["filterConfirm"],
    },
    {
      selector: s.filterClear,
      description: "篩選視窗的「清除篩選」按鈕",
      required: true,
      appliesTo: "both",
      keys: ["filterClear"],
    },
  ];
}

/** Checked with the search modal open; the search is never submitted. */
function searchFlowSpecs(s: SelectorMap): SelectorSpec[] {
  return [
    {
      selector: `${s.topNavBtn} ${s.searchIcon}`,
      description: "搜尋按鈕（導覽列的放大鏡圖示）",
      required: true,
      appliesTo: "both",
      keys: ["searchIcon"],
    },
    {
      selector: s.searchModal,
      description: "搜尋視窗",
      required: true,
      appliesTo: "both",
      keys: ["searchModal"],
    },
    {
      selector: s.searchInput,
      description: "搜尋輸入框",
      required: true,
      appliesTo: "both",
      keys: ["searchInput"],
    },
    {
      selector: `${s.searchModal} ${s.searchSubmit}`,
      description: "搜尋視窗的送出按鈕",
      required: true,
      appliesTo: "both",
      keys: ["searchSubmit"],
    },
  ];
}

/** Checked stage by stage up to the open lend dialog; no member is ever clicked. The two ★ rows
 *  (`lendButtonHost`, `anyDialogClose`) are evaluated by the flow itself, not by `checkSelectors`. */
function lendFlowSpecs(s: SelectorMap): SelectorSpec[] {
  const item = s.libraryItem;
  return [
    {
      selector: `${item}:not(:has(${s.borrowedBadge}))`,
      description: "自己買的書（不是借入的）",
      required: true,
      appliesTo: "both",
      keys: ["libraryItem", "borrowedBadge"],
    },
    {
      selector: `${item} ${s.detailTrigger}`,
      description: "書籍詳情按鈕「⋯」（新站）",
      required: true,
      appliesTo: "next",
      keys: ["detailTrigger"],
    },
    {
      selector: `${item} ${s.detailTriggerLegacy}`,
      description: "書籍詳情按鈕「⋯」（舊站 fallback）",
      required: true,
      appliesTo: "legacy",
      keys: ["detailTriggerLegacy"],
    },
    {
      selector: `${item} ${s.detailTriggerLoose}`,
      description: "書籍詳情按鈕（寬鬆比對，新站）",
      required: false,
      appliesTo: "next",
      keys: ["detailTriggerLoose"],
    },
    {
      selector: `${item} ${s.detailTriggerLooseLegacy}`,
      description: "書籍詳情按鈕（寬鬆比對，舊站 fallback）",
      required: false,
      appliesTo: "legacy",
      keys: ["detailTriggerLooseLegacy"],
    },
    {
      selector: s.bookDetailModal,
      description: "書籍詳情視窗",
      required: true,
      appliesTo: "both",
      keys: ["bookDetailModal"],
    },
    {
      selector: `${s.bookDetailModal} ${s.lendIcon}`,
      description: "「借出」圖示",
      required: true,
      appliesTo: "both",
      keys: ["lendIcon"],
    },
    {
      selector: `${s.bookDetailModal} ${s.lendButtonHost}`,
      description: "「借出」按鈕（圖示外層可點擊的元素）",
      required: true,
      appliesTo: "both",
      keys: ["lendButtonHost"],
    },
    {
      selector: `${s.dialog} ${s.dialogTitle}`,
      description: "「借出書籍」對話框標題",
      required: true,
      appliesTo: "both",
      keys: ["dialog", "dialogTitle"],
    },
    {
      selector: `${s.dialog} ${s.dialogClose}`,
      description: "對話框的關閉按鈕",
      required: true,
      appliesTo: "both",
      keys: ["dialogClose"],
    },
    {
      selector: `${s.dialog} ${s.lendMemberItem} ${s.lendMemberName}`,
      description: "借出名單的成員名稱",
      required: true,
      appliesTo: "both",
      keys: ["lendMemberItem", "lendMemberName"],
    },
    {
      selector: `${s.dialog} ${s.lendMemberItem} ${s.lendMemberAvatar}`,
      description: "借出名單的成員頭像",
      required: false,
      appliesTo: "both",
      keys: ["lendMemberAvatar"],
    },
    {
      selector: s.anyDialogClose,
      description: "關閉後還開著的對話框（應為 0 個）",
      required: false,
      appliesTo: "both",
      keys: ["anyDialogClose"],
    },
  ];
}

/** The single entry for every check list; pass a modified copy of `READMOO_SELECTORS` (`--break`). */
export function buildSpecs(
  selectors: SelectorMap = READMOO_SELECTORS,
): SelectorSpecs {
  return {
    LIBRARY_SELECTORS: librarySpecs(selectors),
    ME_SELECTORS: meSpecs(selectors),
    ARCHIVE_FLOW_SELECTORS: archiveFlowSpecs(selectors),
    SEARCH_FLOW_SELECTORS: searchFlowSpecs(selectors),
    LEND_FLOW_SELECTORS: lendFlowSpecs(selectors),
  };
}
