<!--
GitHub Release 策展式筆記範本。

用法：
1. 發布前複製本檔為 docs/release-notes/<tag>.md（例如 docs/release-notes/v1.5.0.md）。
2. 參考 CHANGELOG.md 對應版本的繁中內容，填入下方各區段。
   - 繁體中文區段：直接取用 / 改寫 CHANGELOG 的策展敘述。
   - English 區段：策展翻譯（非逐字直譯），調整為自然英文。
3. 用不到的分類整個刪掉（不要留空標題）。
4. 不需要手動加 commit 清單與 Full Changelog —— cicd.yml 的 release job
   會自動把 commit 清單收進 <details> 折疊區，並補上 Full Changelog 連結。

注意：本檔（TEMPLATE.md）不會被 release job 取用，只有 v*.md 會。
CHANGELOG.md 維持全繁體中文，本檔則是雙語對外發佈用。

雙語順序為刻意設計：對外的 GitHub Release 面向國際讀者，故 English 段落
置於繁體中文之前，與專案內部文件「繁中優先」的慣例不同，請勿改回繁中優先。
-->

# English

## New Features

-

## Improvements

-

## Bug Fixes

-

## Developer Experience

-

---

# 繁體中文

## 功能新增

-

## 改善調整

-

## 問題修正

-

## 開發者體驗

-
