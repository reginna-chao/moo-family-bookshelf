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
├── crypto/          # Sync code encode/decode (userId hashing lives in shared/src/crypto/)
└── api/             # API client (configurable endpoint)

shared/src/         # moo-family-bookshelf-shared — consumed by extension/, pwa/ and worker/
├── api/            # Wire types (BoolFlag / envelope / family / personal-books / public-shelf / verify records) + endpoint URL validation + sync-code @host classification + backend data-field runtime coercion + member / bookshelf payload validation
├── borrow/         # Borrow wire types + borrow-list payload validation + borrow-request failure copy (error code → 繁中 string) + borrow-history cap and its UI hints
├── config/         # Readmoo host/selector config, report links
├── crypto/         # deriveUserId / sha256Hex — the single userId hashing implementation for Extension and PWA
├── familyShelf/    # Family-shelf sort, update tracking, pref refs + pref-sync controller
├── hostNote/       # SyncCodeHostNote copy (join / verify / onboarding lead-ins)
├── icons/          # Inline brand SVG paths
├── invite/         # Invite message templates
├── personal/       # Personal-shelf save strategy (PUT vs PATCH) + full-PUT conflict rebase + save-error copy
├── publicShelf/    # Public-shelf local-vs-server divergence rule
└── unkick/         # Member-removal copy (remove confirm / un-kick notice / refused rejoin) + rejoin-wait hours
```

### The `shared/` Package

- Source-only package (no build step); `extension/`, `pwa/` and `worker/` import the `.ts` files directly — the first two bundle them with their own Vite config, `worker/` with wrangler's esbuild. All three map the package via `paths` → `../shared/src/*` in their `tsconfig.json`.
- Put logic here when Extension and PWA must behave identically; drift between two copies is the failure mode it exists to prevent. The Worker consumes it too where a client rule and a server-side boundary check must agree (e.g. the Readmoo cover-URL whitelist in `src/config/readmoo.ts`).
- **Runtime-agnostic.** It is also imported by Node scripts run under `tsx` (`extension/scripts/verify-build.ts`, `verify-selectors.ts`). `tsconfig.json` includes the `DOM` lib (needed for `URLSearchParams` typing), so `no-restricted-globals` in `shared/eslint.config.js` blocks `document` / `window` / `localStorage` / `sessionStorage` / `navigator`. Take such values as parameters from the caller instead.
- **Structural parameter types.** `api/entityText.ts`, `api/bookshelfValidation.ts` and `publicShelf/diff.ts` import neither app's entity types nor the entity records in `api/types.ts` (only the `ApiResponse` envelope); they take structural generics. `shared/` thus keeps no dependency on a consumer, every field a caller declares beyond the handled ones (`BoolFlag` flags, numbers, timestamps, index-signature extras) survives untouched, and an edit to a declared type can never silently weaken what a validator enforces.
- **Response validation** (`api/safeText.ts`, `api/entityText.ts`, `api/memberValidation.ts`, `api/bookshelfValidation.ts`, `borrow/validation.ts`) — rationale in `docs/architecture.md` → 伺服器回傳資料的檢查. Never spread a raw element where a module rebuilds one; rebuild optional fields with a conditional spread on `!== undefined` (never truthiness — `null` is a present value); emit aggregate `console.warn`s only — at most one per concern (the bookshelf check has two: members, books), never one per element; keep the `[memberValidation]` / `[bookshelfValidation]` / `[borrowValidation]` log prefixes — they name the check, and both apps' tests assert on them.
- **Error code → copy** (`borrow/messages.ts`): take only the machine-readable `code`, look it up in a `Map` (never an object literal — `"__proto__"` / `"toString"`), and never add a server `message` / `rawMessage` parameter as a fallback (`docs/architecture.md` → 借閱失敗文案只接受錯誤代碼).
- Covered in CI by the `Lint (shared)` / `Typecheck (shared)` steps of the `extension-check` job (`shared/**` is inside that job's path filter), and `shared/**` also sits in `worker-check`'s filter, so a shared change runs the Worker checks too. No test script of its own — behaviour is covered by `extension/tests/`, `pwa/tests/` and `worker/tests/`.
- Commands: `pnpm --filter moo-family-bookshelf-shared lint` / `typecheck`.

### Coding Conventions

- Functional components with hooks. No class components.
- Props defined as `interface`, named `{Component}Props`.
- Keep files at 200 lines or fewer. Split large components. Enforced by ESLint `max-lines` (`error`, raw lines — blank lines and comments count, so it matches `wc -l`) on `src/**/*.{ts,tsx}` in `extension/`, `pwa/` and `shared/`; tests, scripts and configs are exempt. Files that already exceeded 200 lines when the rule landed are pinned in `MAX_LINES_LEGACY_CEILINGS` in that package's `eslint.config.js` at their line count then, so they may shrink but never grow. When a listed file shrinks, lower its number in the same change; once it is at or under 200, delete its entry. Never raise a number or add an entry — split the file instead.
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

The account check (issue #271) is cached per page load (`dialog/accountIdentityCheck.ts`), but the cache serves the Dialog-open check ONLY. Every book sync — the mount auto-sync and the manual sync alike — re-reads `#/me` through `verifyAccountIdentity` right before uploading (issue #277; `dialog/AccountCheckContext.ts` → `recheck`); a non-match uploads nothing and drops the cache. While the status is `unknown` at mount, the auto-sync is skipped altogether. Never compare against `USER_EMAIL_KEY`: it is a cache, not the identity.

The floating button's pending-borrow badge (`content/pendingBorrowBadge.ts`, issue #275) fetches only when Readmoo's `ReadmooNext.email` login cookie (`content/pageAccountCookie.ts`) confirms the stored userId; otherwise it sends no request and clears the badge. The Dialog never lets that cookie CONFIRM the stored user — its account check is `#/me` (docs/architecture.md → 讀墨帳號確認（已加入家庭時）); since issue #277 `verifyAccountIdentity` reads the cookie only as a VETO (a decodable cookie naming another account turns a `#/me` match into `unknown`, so nothing uploads). Its main view still sets the badge through `onPendingBorrowCountChange` (`dialog/App.tsx`), including under `unknown`.

### Commands

- `pnpm dev` — dev server
- `pnpm build` — production build
- `pnpm build:firefox:dev` — dev-mode Firefox build → load `dist-firefox-direct/manifest.json` via about:debugging
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint with `--max-warnings 0` (warnings fail; Prettier runs separately via `pnpm format`)
- `pnpm test` — Vitest (unit + component)
- `pnpm test:e2e` — Playwright E2E
