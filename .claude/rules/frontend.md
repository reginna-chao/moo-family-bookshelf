---
paths:
  - "extension/**"
  - "pwa/**"
  - "shared/**"
---

## Frontend Architecture Rules

Applies to: `extension/src/`, `pwa/src/`, `shared/src/`

### Tech Stack

- React 19, TypeScript 5.x, Vite
- Tailwind CSS for styling
- Chrome Extension Manifest V3
- Vitest + React Testing Library (unit/component), Playwright (E2E)

### Project Structure

```
extension/src/
├── dialog/          # Dialog UI injected into Readmoo pages
│   ├── Onboarding.tsx
│   ├── PersonalShelf.tsx
│   ├── FamilyShelf.tsx
│   └── FamilySettings.tsx
├── settings/        # Extension settings page
├── content/         # Content Script (scrape + inject)
├── background/      # Service Worker
└── api/             # API client (configurable endpoint)

shared/src/         # moo-family-bookshelf-shared — consumed by extension/, pwa/ and worker/
├── api/            # Wire types (BoolFlag / envelope / family / personal-books / public-shelf / verify records) + endpoint URL validation + sync-code @host classification + backend data-field runtime coercion + member / bookshelf / personal-books / verify-method payload validation + the shared envelope reader + hex-id assertion
├── borrow/         # Borrow wire types + borrow-list payload validation + borrow-request failure copy (error code → 繁中 string) + borrow-history cap and its UI hints
├── config/         # Readmoo host/selector config, report links
├── crypto/         # deriveUserId / sha256Hex + sync code encode/decode
├── familyShelf/    # Family-shelf sort, update tracking, pref refs + pref-sync controller
├── hostNote/       # SyncCodeHostNote copy (join / verify / onboarding lead-ins)
├── icons/          # Inline brand SVG paths
├── invite/         # Invite message templates
├── personal/       # Personal-shelf save strategy (PUT vs PATCH) + full-PUT conflict rebase + save-error copy
├── publicShelf/    # Public-shelf local-vs-server divergence rule
├── safeUrl/        # Readmoo cover / book URL render-time filters (return `String(url)`)
└── unkick/         # Member-removal copy (remove confirm / un-kick notice / refused rejoin) + rejoin-wait hours
```

### The `shared/` Package

- Source-only package (no build step); `extension/`, `pwa/` and `worker/` import the `.ts` files directly — the first two bundle them with their own Vite config, `worker/` with wrangler's esbuild. All three map the package via `paths` → `../shared/src/*` in their `tsconfig.json`.
- Put logic here when Extension and PWA must behave identically; drift between two copies is the failure mode it exists to prevent. The Worker consumes it too where a client rule and a server-side boundary check must agree (e.g. the Readmoo cover-URL whitelist in `src/config/readmoo.ts`).
- **Runtime-agnostic.** It is also imported by Node scripts run under `tsx` (`extension/scripts/verify-build.ts`, `verify-selectors.ts`). `tsconfig.json` includes the `DOM` lib (needed for `URLSearchParams` typing), so `no-restricted-globals` in `shared/eslint.config.js` blocks `document` / `window` / `localStorage` / `sessionStorage` / `navigator`. Take such values as parameters from the caller instead.
- **Structural parameter types.** `api/entityText.ts`, `api/bookshelfValidation.ts`, `api/personalBooksValidation.ts`, `api/verifyValidation.ts` and `publicShelf/diff.ts` import neither app's entity types nor the entity records in `api/types.ts` (only the `ApiResponse` envelope and, where flags are coerced, the `BoolFlag` enum; `verifyValidation.ts` also imports the `VerifyMethod` union it checks against); they take structural generics. `shared/` thus keeps no dependency on a consumer, every field a caller declares beyond the handled ones (`BoolFlag` flags, numbers, timestamps, index-signature extras) survives untouched, and an edit to a declared type can never silently weaken what a validator enforces. The exception is `verifyValidation.ts`, which — like `memberValidation.ts` — REBUILDS its record (`{ method }` only): a field added to `VerifyInfo` later must be added there too, or it is dropped.
- **Response validation** (`api/safeText.ts`, `api/entityText.ts`, `api/memberValidation.ts`, `api/bookshelfValidation.ts`, `api/personalBooksValidation.ts`, `api/verifyValidation.ts`, `borrow/validation.ts`) — rationale in `docs/architecture.md` → 伺服器回傳資料的檢查. Never spread a raw element where a module rebuilds one; rebuild optional fields with a conditional spread on `!== undefined` (never truthiness — `null` is a present value); emit aggregate `console.warn`s only — at most one per concern (the bookshelf check has two: members, books), never one per element; keep the `[memberValidation]` / `[bookshelfValidation]` / `[borrowValidation]` / `[personalBooksValidation]` / `[verifyValidation]` log prefixes — they name the check, and both apps' tests assert on them. The one sanctioned spread of a raw element is `personalBooksValidation.ts`: it only coerces each book's `BoolFlag` fields and never drops a book, because the full-PUT save sends every book field back and a dropped book would be deleted from the server.
- **Render-time URL filters** (`safeUrl/safeCoverUrl.ts`, `safeUrl/safeBookUrl.ts`) return `String(url)`, never `url` (`docs/architecture.md` → 伺服器回傳資料的檢查); the domain rule stays in `config/readmoo.ts`.
- **Error code → copy** (`borrow/messages.ts`): take only the machine-readable `code`, look it up in a `Map` (never an object literal — `"__proto__"` / `"toString"`), and never add a server `message` / `rawMessage` parameter as a fallback (`docs/architecture.md` → 借閱失敗文案只接受錯誤代碼).
- Covered in CI by the `Lint (shared)` / `Typecheck (shared)` steps of the `extension-check` job (`shared/**` is inside that job's path filter), and `shared/**` also sits in `worker-check`'s filter, so a shared change runs the Worker checks too. No test script of its own — behaviour is covered by `extension/tests/`, `pwa/tests/` and `worker/tests/`.
- Commands: `pnpm --filter moo-family-bookshelf-shared lint` / `typecheck`.

### Extension ↔ PWA twins

Logic that must behave identically but depends on each app's runtime stays duplicated as a twin pair. Apply every behavioural edit to BOTH sides in the same change, or hoist it into `shared/` when it has no app-specific dependency. Parity tests enforce some pairs and matching behaviour tests others; the rest rely on review. The rationale lives in `docs/architecture.md` → PWA 用戶端的設計理由 (Extension-only reasoning: → Extension 用戶端的設計理由). When shortening a comment in one twin, point it at the SAME doc section the other twin's comment names.

The table lists all 62 pairs — 12 differing only in imports / comments / CSS (none is byte-identical: every parity-tested pair carries a `// Twin:` pointer line naming the other side), 50 with substantive differences (20 of them under different file names) — and is the review checklist: a change to one side of a `必須一致` pair MUST land on the other side in the same PR. Add a row when you create a twin; remove it when the pair is hoisted into `shared/`. "hoistable to `shared/`" marks a pair or fragment with no app dependency. Classes:

- `必須一致（parity）` — enforced by a `*.parity.test.ts` source compare — the `TWINS` table of `*/tests/unit/useSyncCodeHostVerdict.parity.test.ts` holds every row of this class; add the pair there when you add a row here.
- `必須一致（行為測試）` — behaviour must match, implementation may differ; the contract is a matching assertion in BOTH apps' test suites, named in the row.
- `平台差異` — differs because of the runtime (shadow DOM, `browser.storage` vs `localStorage`, routing, CSP, Readmoo DOM automation); keep in step on everything else.
- `刻意分歧` — product decision; reason in the row. Never "fix" into a twin.
- `待釐清（#N）` — drift with no recorded reason; the GitHub issue in the row owns the decision. `待釐清（內部）` is drift no user can observe (type location, API shape, file structure); it has no issue — do not widen a change to converge it.

<!-- prettier-ignore -->
| Pair (Extension ↔ PWA) | Class | Notes |
| --- | --- | --- |
| `extension/src/dialog/useFamilyShelfPrefs.ts` ↔ `pwa/src/hooks/useFamilyShelfPrefs.ts` | `必須一致（parity）` | Import path + comments; the logic is `FamilyPrefsSync` in `shared/src/familyShelf/`. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). |
| `extension/src/dialog/useLoadMore.ts` ↔ `pwa/src/hooks/useLoadMore.ts` | `必須一致（parity）` | Identical except the `// Twin:` pointer. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). |
| `extension/src/dialog/usePublicShelfActions.ts` ↔ `pwa/src/hooks/usePublicShelfActions.ts` | `必須一致（parity）` | Import paths + the `// Twin:` pointer; tested only through `PublicShareDialog` on each side. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). |
| `extension/src/dialog/useSyncCodeHostVerdict.ts` ↔ `pwa/src/hooks/useSyncCodeHostVerdict.ts` | `必須一致（parity）` | Compared comments included, after normalising directory and whitespace (both copies import `moo-family-bookshelf-shared/crypto/syncCode`) (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`). A comment edit must land identically on both sides, and each copy must still name the other's directory. |
| `extension/src/hooks/useAnchoredPosition.ts` ↔ `pwa/src/hooks/useAnchoredPosition.ts` | `必須一致（parity）` | Identical except the `// Twin:` pointer. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). The pure `computeAnchoredPosition` is hoistable to `shared/`. |
| `extension/src/hooks/useDebouncedCallback.ts` ↔ `pwa/src/hooks/useDebouncedCallback.ts` | `必須一致（parity）` | Identical except the `// Twin:` pointer. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). |
| `extension/src/hooks/useTimedFlag.ts` ↔ `pwa/src/hooks/useTimedFlag.ts` | `必須一致（parity）` | Identical except the `// Twin:` pointer. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). |
| `extension/src/utils/appEnv.ts` ↔ `pwa/src/utils/appEnv.ts` | `必須一致（parity）` | Comment only; reads `import.meta.env.MODE`, so it stays per app. Parity-tested (`*/tests/unit/useSyncCodeHostVerdict.parity.test.ts`, #353). |
| `extension/src/dialog/MemberList.tsx` ↔ `pwa/src/components/MemberList.tsx` | `必須一致（行為測試）` | `MEMBER_NOT_FOUND` on an owner kick counts as a completed removal (`handleRemove` ↔ the remove branch of `handleConfirm`); both `*/tests/component/MemberList.test.tsx`. Extension-only: deleting `readmooName` (platform, it is scraped) and the transfer keep/clear-endpoint choice (#387). |
| `extension/src/dialog/PatternLock.tsx` ↔ `pwa/src/components/PatternLock.tsx` | `必須一致（行為測試）` | Wire format `selected.join(",")` (`"a,b,c,d"`); both `*/tests/component/PatternLock.test.tsx`. Otherwise two implementations: submit model, copy and error precedence → #385; the PWA cancel serves its login screen. |
| `extension/src/dialog/useFamilySettingsLeave.ts` ↔ `pwa/src/hooks/useLeaveFamily.ts` | `必須一致（行為測試）` | `settleLeave`: `MEMBER_NOT_FOUND` / `FAMILY_NOT_FOUND` on a self-leave count as success; `extension/tests/unit/dialog/useFamilySettingsLeave.test.ts` ↔ `pwa/tests/unit/hooks/useLeaveFamily.test.ts`. Fallback copy 「發生未知錯誤」 vs 「離開失敗」 → #386. The `settleLeave` decision is hoistable to `shared/`. |
| cooldown helpers in `extension/src/api/auth-refresh.ts` ↔ `pwa/src/utils/recoveryCooldown.ts` | `平台差異` | Same clamp (default 300 s, max 3600 s, self-heal on read); async `browser.storage` vs sync `localStorage`. Clamp math hoistable to `shared/`. |
| `extension/src/api/client.ts` ↔ `pwa/src/api/client.ts` | `平台差異` | Token storage, the Extension's synthesized errors and per-app methods (e.g. `createQrToken` / `generateOtp` vs `getPublicShelf` / `markVerifyPrompted`). Only the wire-type façade is pinned (`*/tests/unit/wireTypeFacade.parity.test.ts`), not behaviour. |
| `extension/src/constants.ts` ↔ `pwa/src/constants.ts` | `平台差異` | Partial twin: only `DEFAULT_API_ENDPOINT` (different env var) and `buildInviteUrl` (`DEFAULT_PWA_URL` vs `window.location`). |
| `seenKey` / `chipsKey` in `extension/src/constants.ts` ↔ `pwa/src/hooks/updateTracking.ts` | `平台差異` | Key prefix `moo:familyBookshelfSeen:` vs `familyBookshelfSeen:` (per storage); the tracking rules live in `shared/src/familyShelf/`. |
| `extension/src/dialog/BorrowTab.tsx` ↔ `pwa/src/pages/BorrowPage.tsx` | `平台差異` | The Extension drives Readmoo's lend dialog (DOM automation, member picker). The `isActive` / owner-name helpers are hoistable to `shared/`. |
| `extension/src/dialog/LazyCover.tsx` ↔ `pwa/src/components/LazyCover.tsx` | `平台差異` | Extension adds `width` / `height` / `style` for an inline layout-shift placeholder; the PWA sizes via `className`. |
| `extension/src/dialog/useBookSort.ts` ↔ `pwa/src/hooks/useBookSort.ts` | `平台差異` | Async `extension/src/storage/bookSort.ts` with a `userChoseRef` race guard vs sync per-user `localStorage`; `(shelf)` vs `(userId, shelf)`. |
| `extension/src/dialog/useDirtyBookIds.ts` ↔ `pwa/src/hooks/usePersonalShelfDirty.ts` | `平台差異` | Extension adds `moveRenamedDirty` (renames are only seen by scraping) and returns `dirtyRef`; the PWA returns `isDirty`. |
| `extension/src/dialog/useFamilyShelfViewMode.ts` ↔ `pwa/src/hooks/useFamilyShelfViewMode.ts` | `平台差異` | Async `extension/src/storage/viewMode.ts` (global key) vs sync per-user `localStorage`; `()` vs `(userId)`. |
| `extension/src/dialog/useManualLendNotice.ts` ↔ `pwa/src/hooks/useManualLendNotice.ts` | `平台差異` | `browser.storage.local` (async) vs `localStorage` (sync, per-user key). |
| `extension/src/dialog/useSavePersonalShelf.ts` ↔ `pwa/src/hooks/usePersonalShelfSave.ts` | `平台差異` | Extension also writes the personal-books cache and settles the synced shelf; the save strategy is in `shared/src/personal/`. Status type and param names differ (internal). |
| `extension/src/dialog/VerificationPrompt.tsx` (+ `useVerificationPrompt.ts`) ↔ `pwa/src/components/LandingVerifyScreen.tsx` | `平台差異` | Same PIN / pattern verify step, in the Dialog's re-auth vs the PWA's landing login; lock / countdown copy comes from the `verificationMessages` ↔ `retryMessage` pair. |
| `extension/src/hooks/useDismissableMenu.ts` ↔ `pwa/src/hooks/useDismissableMenu.ts` | `平台差異` | Extension adds ShadowRoot handling; PWA scroll / resize dismissal is opt-in `dismissOnScroll` (default off, reason in its JSDoc). `returnFocusOnEscape` pinned in both `*/tests/component/useDismissableMenu.test.tsx`. Contract below the table. |
| `extension/src/storage/selfDeparture.ts` ↔ `pwa/src/utils/selfDeparture.ts` | `平台差異` | Async `browser.storage` vs sync `localStorage`; `settle` may return a Promise only on the Extension; key constant in `extension/src/constants.ts` vs the PWA file. |
| `extension/src/dialog/BorrowSection.tsx` ↔ `pwa/src/components/BorrowSectionView.tsx` | `刻意分歧` | Styling system (moo-\* CSS vs Tailwind); logic identical — review by eye. Heading level `<h4>` vs `<h3>`. |
| `extension/src/dialog/familyGoneNotice.ts` (+ `FAMILY_GONE_ERROR_CODES` in `auth-refresh.ts`) ↔ `pwa/src/utils/joinErrorMessages.ts` | `刻意分歧` | Copy differs because the outcome does: the PWA logs out, the Extension unbinds the family. |
| `extension/src/dialog/FavoriteButton.tsx` ↔ `pwa/src/components/FavoriteButton.tsx` | `刻意分歧` | Styling system (moo-\* CSS vs Tailwind); logic identical — review by eye. Icon 16 vs 18 px. |
| `extension/src/dialog/memberSettingsMessages.ts` ↔ `memberSettingsErrorMessage` in `pwa/src/components/MemberList.tsx` | `刻意分歧` | The PWA omits the `AUTH_REFRESH_RATE_LIMITED` passthrough (reason in the `useBorrowAction` row). The rest is hoistable to `shared/`. |
| `extension/src/dialog/publicShareMessages.ts` ↔ `pwa/src/utils/publicShareMessages.ts` | `刻意分歧` | `UNAUTHORIZED` copy (PWA: 請重新登入; Extension: 請重新開啟書櫃) and the 429 helper (`buildRetryMessage` vs `rateLimitedMessage`) differ on purpose, pinned by `pwa/tests/unit/publicShareMessages.test.ts`; `publicShelfErrorMessage` omits the passthrough (see `useBorrowAction`). Hoistable to `shared/` with per-app copy injected. |
| `extension/src/dialog/SyncCodeHostNote.tsx` ↔ `pwa/src/components/SyncCodeHostNote.tsx` | `刻意分歧` | Styling system (moo-\* CSS vs Tailwind); logic identical — review by eye. The copy is in `shared/src/hostNote/`. |
| `extension/src/dialog/useBorrowAction.ts` ↔ `pwa/src/hooks/useBorrowAction.ts` | `刻意分歧` | PWA `borrowFailureText` omits the Extension's passthrough of the client-synthesized `AUTH_REFRESH_RATE_LIMITED`: `pwa/src` has neither that code nor any synthesize path, so a passthrough could only render server-supplied text. Book type name differs (internal). |
| `extension/src/dialog/verificationMessages.ts` ↔ `pwa/src/utils/retryMessage.ts` | `刻意分歧` | `rateLimitedEnvelopeMessage`: the PWA treats `retryAfter === 0` as unusable and shows the static copy, the Extension renders a 「0 秒」 countdown (see the PWA function's JSDoc). Trailing 「。」 only in the PWA → #386. Hoistable to `shared/` (0-handling as a parameter). |
| `extension/src/dialog/VerificationSettings.tsx` ↔ `pwa/src/components/VerifySetupPrompt.tsx` | `刻意分歧` | Both call `setVerifyMethod`; the Extension's is a settings panel with OTP, the PWA's a one-shot post-login prompt (`markVerifyPrompted`). |
| `extension/src/dialog/VersionWarning.tsx` ↔ `pwa/src/components/VersionWarning.tsx` | `刻意分歧` | Styling system (inline `style` vs Tailwind); logic identical — review by eye. Tested on the PWA side only. |
| `extension/src/dialog/BookCard.tsx` ↔ `pwa/src/components/FamilyBookCard.tsx` | `待釐清（#381）` | Pending borrow: the Extension shows a disabled 「申請中」 button, the PWA a 「申請已送出」 label. The Extension also exports `BookWithMember` / `FilterButton` from here. |
| `extension/src/dialog/FamilyBookRow.tsx` ↔ `pwa/src/components/FamilyBookRow.tsx` | `待釐清（#381）` | PWA renders no borrow control unless `showBorrowButton`, so a pending request shows nothing in row view. Mobile layout (`isMobile` stack vs pill) is platform; book type name is internal. |
| `extension/src/dialog/FamilyShelfBookList.tsx` ↔ `pwa/src/components/FamilyBookList.tsx` | `待釐清（#381）` | PWA `showBorrowButton` adds `!borrowRequestPending && canBorrow`, hiding the pending state in row view; the Extension shows 「申請中」. The PWA also owns empty state and load-more here. |
| `extension/src/dialog/useSearch.ts` ↔ `pwa/src/hooks/useSearch.ts` | `待釐清（#382）` | Only the Extension returns `resetSearch` and clears the search on member-filter change (`FamilyShelf.tsx`); the PWA keeps the term. |
| `extension/src/dialog/BookSortDropdown.tsx` ↔ `pwa/src/components/BookSortDropdown.tsx` | `待釐清（#383）` | Extension: listbox keyboard nav (`aria-activedescendant`, Home / End / Arrows), `type="button"`, `aria-haspopup`; PWA: plain menu. Portal + anchored position is platform. |
| `extension/src/dialog/CategoryDropdown.tsx` ↔ `pwa/src/components/CategoryFilter.tsx` | `待釐清（#383）` | PWA trigger lacks `type="button"` / `aria-haspopup`; controlled `open` vs internal state. `buildCategories` / `filterByCategory` are byte-identical — hoistable to `shared/`. |
| `extension/src/dialog/MemberDropdown.tsx` ↔ `pwa/src/components/MemberDropdown.tsx` | `待釐清（#383）` | PWA trigger lacks `type="button"` / `aria-haspopup="listbox"`. The Extension re-exports the filter sentinels (internal, see `memberFilterOptions`). |
| `extension/src/dialog/OverflowMenu.tsx` ↔ `pwa/src/components/OverflowMenu.tsx` | `待釐清（#383）` | Extension has first-item focus, Arrow / Tab / Escape nav and focus restore; the PWA has none. Portal target (shadow container vs `document.body`) is platform. |
| `extension/src/dialog/PublicShareDialog.tsx` ↔ `pwa/src/components/PublicShareDialog.tsx` | `待釐清（#383）` | Extension has `role="dialog"`, `aria-modal`, Escape, focus trap and return, a labelled close button; the PWA has none and closes on backdrop click. URL source (`getPublicShelfUrl` vs `window.location.origin`) is platform. |
| `extension/src/dialog/BookRow.tsx` ↔ `pwa/src/components/BookRow.tsx` | `待釐清（#384）` | Share toggle `aria-pressed` + `aria-label` only on the PWA; cover `alt`, the empty-author line and `isMobile` also differ. |
| `extension/src/dialog/PinInput.tsx` ↔ `pwa/src/components/PinInput.tsx` | `待釐清（#385）` | Non-digits rejected with copy vs stripped silently; mismatch copy 「PIN 碼不一致，請重新輸入」 vs 「兩次輸入的 PIN 碼不一致，請重新輸入。」. The PWA-only `onCancel` / `errorAnnouncement` serve its login screen. |
| `extension/src/dialog/UnkickNotice.tsx` ↔ `pwa/src/components/UnkickNotice.tsx` | `待釐清（#386）` | Fallback copy 「發生未知錯誤」 vs 「操作失敗」; error state `""` vs `null`. |
| `extension/src/dialog/useDisplayName.ts` ↔ `pwa/src/hooks/useDisplayNameEditor.ts` | `待釐清（#386）` | Failure copy 「儲存失敗，請稍後再試」 vs 「更新失敗，請稍後再試」. Persistence (`browser.storage` vs the family context) is platform. |
| `extension/src/dialog/useFamilySettingsDelete.ts` ↔ `pwa/src/hooks/useDeleteAccount.ts` | `待釐清（#386）` | Fallback copy 「發生未知錯誤」 vs 「移除失敗」. Clearing `browser.storage.local` after the delete is platform. |
| `extension/src/dialog/FamilyShelfToolbar.tsx` ↔ `pwa/src/components/FamilyShelfToolbar.tsx` | `待釐清（#387）` | Result count (`SearchBar`) only on the Extension; the PWA uses an inline `<input>`; row order differs. |
| `extension/src/dialog/FloatingActionBar.tsx` ↔ `pwa/src/components/FloatingActionBar.tsx` | `待釐清（#387）` | 「已儲存」 state and `role="toolbar"` only on the PWA; `onCancel` vs `onCancelChanges`. `shouldShowFloatingBar` is hoistable to `shared/`. |
| `extension/src/dialog/ManualLendDialog.tsx` ↔ `pwa/src/components/ManualLendDialog.tsx` | `待釐清（#387）` | Header close (X) button only on the Extension. |
| `extension/src/dialog/BorrowRequestCard.tsx` ↔ `pwa/src/components/BorrowCard.tsx` | `待釐清（內部）` | Status lookup `Map` + `UNKNOWN_STATUS` vs exhaustive `switch`; labels identical. `formatRelativeTime` (byte-identical) and the status-label table are hoistable to `shared/`. |
| `extension/src/dialog/FamilyDataContext.tsx` (+ `useFamilyData*.ts`, `familyDataTypes.ts`) ↔ `pwa/src/hooks/useFamilyData.tsx` | `待釐清（內部）` | Same context contract; the Extension is split across 8 files with its types in `familyDataTypes.ts`. Storage differs by platform. |
| `extension/src/dialog/FamilyShelfStatus.tsx` ↔ `pwa/src/components/FamilyShelfStatus.tsx` | `待釐清（內部）` | The PWA exports an extra `FamilyShelfLoading`; the Extension uses its generic `LoadingState.tsx`. |
| `extension/src/dialog/memberFilterOptions.tsx` ↔ `pwa/src/components/memberFilterOptions.tsx` | `待釐清（內部）` | Filter sentinels + `MemberFilterValue` declared here in the Extension but in `pwa/src/hooks/useFamilyShelfBooks.ts`; PWA options carry `key`. Sentinels + type hoistable to `shared/`. |
| `extension/src/dialog/personalShelfUpload.ts` ↔ `pwa/src/hooks/personalShelfUpload.ts` | `待釐清（內部）` | `LandedSave` is flat vs a discriminated union. Legacy-id handling (`includePromoted: true`) is Extension-only (platform). |
| `extension/src/dialog/StatusFilterBar.tsx` ↔ `pwa/src/components/PersonalShelfFilterBar.tsx` | `待釐清（內部）` | `StatusFilter` declared twice (here vs `pwa/src/hooks/usePersonalShelfView.ts`); the PWA adds `aria-pressed` and the sort control. Type + labels hoistable to `shared/`. |
| `extension/src/dialog/useFamilySettingsCopy.ts` ↔ `pwa/src/hooks/useSyncCodeShare.ts` | `待釐清（內部）` | The PWA does not clear a running timer before re-arming; neither uses `useTimedFlag`. `navigator.share` is PWA platform. |
| `extension/src/dialog/useFamilyShelfBooks.ts` ↔ `pwa/src/hooks/useFamilyShelfBooks.ts` | `待釐清（內部）` | `BookWithMember` lives in `extension/src/dialog/BookCard.tsx` vs locally; sentinel location (see `memberFilterOptions`); the PWA memoises `totalBooks`. |
| `extension/src/dialog/useRetryCountdown.ts` ↔ `pwa/src/hooks/useRetryCountdown.ts` | `待釐清（內部）` | `{ seconds, start → boolean, onElapsed }` vs `{ remaining, start → void, onExpire }`; the PWA `Math.ceil`s its input. |
| `extension/src/dialog/ViewModeToggle.tsx` ↔ `pwa/src/components/ViewModeToggle.tsx` | `待釐清（內部）` | The PWA declares `FamilyShelfViewMode` a second time (also in its hook). Styling props are platform. |

**`useDismissableMenu` contract.** Keep `returnFocusOnEscape`'s name and semantics identical: on Escape, focus goes back to the trigger so keyboard and screen-reader users land on it (and hear its current name) instead of on `<body>` when the focused option unmounts — but only when focus was in the menu or on its trigger, or had already fallen to the document; a control the user moved to while the menu stayed open keeps focus, and outside click / scroll / resize never move it. Default `true` (ARIA APG button-popup convention); pass `false` only for a special case. The PWA uses `composedPath()` (no shadow DOM, so a plain ancestor walk) only to stay in step. The Extension adds ShadowRoot handling: `eventStartedInMenu` uses `composedPath()` because at document level `e.target` is retargeted to the shadow host, so `menu.contains(e.target)` would read an inside interaction as outside; `composedPath()` returns the real inner nodes and works the same in light DOM (e.g. `BookSortDropdown`, which portals to `document.body` on the dev page). `scroll` events are `composed: false`, so a scroll inside the dialog's shadow tree never reaches `window`: the hook also listens on the trigger's `ShadowRoot` in capture phase (scrolling the dialog's panels then dismisses the menu), and keeps the `window` capture listener for the dev page / light DOM and window-level scroll. Scrolls that start inside the menu or trigger never dismiss (the menu's own `overflow-y: auto` list stays scrollable); resize always closes.

**Not twins** — do not re-add them: `extension/src/dialog/App.tsx` ↔ `pwa/src/App.tsx` and `extension/src/dialog/main.tsx` ↔ `pwa/src/main.tsx` share names but not jobs (Dialog state machine / shadow-root mount vs PWA router / document bootstrap). Same feature, different composition, little shared logic: `extension/src/dialog/SearchBar.tsx` ↔ `pwa/src/components/PersonalShelfSearchBar.tsx`; `FamilySettings{Members,SyncCode,Leave,Delete}Block.tsx` ↔ `Settings{FamilyMembers,SyncCodeShare,LeaveFamilySection,DeleteAccountSection}.tsx`; `FamilyShelf.tsx` ↔ `pwa/src/pages/FamilyShelfPage.tsx`; `PersonalShelf.tsx` ↔ `PersonalShelfPage.tsx`; the `Onboarding*` ↔ `Landing*` join flows. `extension/src/storage/bookSort.ts` and `storage/viewMode.ts` are folded into the `useBookSort` / `useFamilyShelfViewMode` rows.

### PWA import chain

`pwa/src/hooks/useAuth.ts` must never reach `pwa/src/constants.ts`, not even transitively (#266). The Node-side Playwright helpers (`pwa/tests/e2e/helpers/auth-helper.ts`) import `useAuth`, and `constants.ts` reads `import.meta.env` at module load, which is undefined under plain Node — every E2E spec would fail to load while Vitest, `tsc` and ESLint stay green. That is why `PAGE_HASHES` lives in `routes.ts` and the re-verification marker's key and `clearReauthPending` in `utils/reauthPendingKey.ts`, both import-free today: keep them that way (at the very least, nothing that leads to `constants.ts`). Pinned by `pwa/tests/unit/useAuthImportChain.test.ts`.

### Coding Conventions

- Functional components with hooks. No class components.
- Props defined as `interface`, named `{Component}Props`.
- Keep files at 200 lines or fewer. Split large components. Enforced by ESLint `max-lines` (`error`, raw lines — blank lines and comments count, so it matches `wc -l`) on `src/**/*.{ts,tsx}` in `extension/`, `pwa/` and `shared/`; tests, scripts and configs are exempt. Files that already exceeded 200 lines when the rule landed are pinned in `MAX_LINES_LEGACY_CEILINGS` in that package's `eslint.config.js` at their line count then, so they may shrink but never grow. A listed number must EQUAL the file's `wc -l` — `*/tests/unit/eslintMaxLinesCeilings.test.ts` fails on any gap — so when a listed file shrinks, lower its number in the same change; once it is at or under 200, delete its entry. Never raise a number or add an entry — split the file instead, and never squeeze a file under its cap by compressing comments or deleting blank lines: that only moves the split to the next change.
- Extract shared logic into custom hooks (`use*.ts`).
- Max 3 levels of nesting. Use early return.
- No nested ternary operators.
- No `any` type. Use `unknown` + type guards when needed.
- Node helper-script dirs (e.g. `extension/scripts/`) must be covered by a tsconfig project wired into `pnpm typecheck` (see `extension/tsconfig.scripts.json`). When adding a script dir, wire it in — a script with zero static checking in CI is a defect.

### State Management

- `chrome.storage.local` for Extension persistent state (family_id, user_id, API endpoint).
- React state (`useState`) for local UI state.
- Props drilling acceptable for 2 levels max; beyond that, use React Context.

### Dialog State Machine

```
Open Dialog → has family_id in chrome.storage?
  No  → Onboarding (create / join family)
  Yes → Check the Readmoo account on the page (#/me email → deriveUserId vs stored userId)
          match / unknown → Verify family → Main view (Family Shelf | Personal Shelf | Settings)
          mismatch        → Account-mismatch screen (nothing mounted; local reset → Onboarding)
```

The account check (issue #271) is cached per page load (`dialog/accountIdentityCheck.ts`), but the cache serves the Dialog-open check ONLY. Every book sync — the mount auto-sync and the manual sync alike — re-reads `#/me` through `verifyAccountIdentity` right before uploading (issue #277; `dialog/AccountCheckContext.ts` → `recheck`); a non-match uploads nothing and drops the cache. While the status is `unknown` at mount, the auto-sync is skipped altogether. Never compare against `USER_EMAIL_KEY`: it is no longer written (#359) and was never the identity.

The floating button's pending-borrow badge (`content/pendingBorrowBadge.ts`, issue #275) fetches only when Readmoo's `ReadmooNext.email` login cookie (`content/pageAccountCookie.ts`) confirms the stored userId; otherwise it sends no request and clears the badge. The Dialog never lets that cookie CONFIRM the stored user — its account check is `#/me` (docs/architecture.md → 讀墨帳號確認（已加入家庭時）); since issue #277 `verifyAccountIdentity` reads the cookie only as a VETO (a decodable cookie naming another account turns a `#/me` match into `unknown`, so nothing uploads). Its main view still sets the badge through `onPendingBorrowCountChange` (`dialog/App.tsx`), including under `unknown`.

### Commands

- `pnpm dev` — dev server
- `pnpm build` — production build
- `pnpm build:firefox:dev` — dev-mode Firefox build → load `dist-firefox-direct/manifest.json` via about:debugging
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint with `--max-warnings 0` (warnings fail; Prettier runs separately via `pnpm format`)
- `pnpm test` — Vitest (unit + component)
- `pnpm test:e2e` — Playwright E2E
