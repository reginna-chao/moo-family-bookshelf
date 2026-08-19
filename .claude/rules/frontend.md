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
├── crypto/          # Hashing utilities (SHA-256)
└── api/             # API client (configurable endpoint)

shared/src/         # moo-family-bookshelf-shared — consumed by BOTH extension/ and pwa/
├── api/            # Endpoint URL validation + sync-code @host classification
├── config/         # Readmoo host/selector config, report links
├── icons/          # Inline brand SVG paths
├── invite/         # Invite message templates
├── personal/       # Personal-shelf save strategy (PUT vs PATCH)
├── publicShelf/    # Public-shelf local-vs-server divergence rule
└── unkick/         # Un-kick notice copy (removed / cleared / hint)
```

### The `shared/` Package

- Source-only package (no build step); `extension/` and `pwa/` import the `.ts` files directly and bundle them with their own Vite config.
- Put logic here when Extension and PWA must behave identically; drift between two copies is the failure mode it exists to prevent.
- **Runtime-agnostic.** It is also imported by Node scripts run under `tsx` (`extension/scripts/verify-build.ts`, `verify-selectors.ts`). `tsconfig.json` includes the `DOM` lib (needed for `URLSearchParams` typing), so `no-restricted-globals` in `shared/eslint.config.js` blocks `document` / `window` / `localStorage` / `sessionStorage` / `navigator`. Take such values as parameters from the caller instead.
- Covered in CI by the `Lint (shared)` / `Typecheck (shared)` steps of the `extension-check` job (`shared/**` is inside that job's path filter). No test script of its own — behaviour is covered by `extension/tests/` and `pwa/tests/`.
- Commands: `pnpm --filter moo-family-bookshelf-shared lint` / `typecheck`.

### Coding Conventions

- Functional components with hooks. No class components.
- Props defined as `interface`, named `{Component}Props`.
- Keep files under 200 lines. Split large components.
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
  Yes → Verify family → Main view (Family Shelf | Personal Shelf | Settings)
```

### Commands

- `pnpm dev` — dev server
- `pnpm build` — production build
- `pnpm build:firefox:dev` — dev-mode Firefox build → load `dist-firefox-direct/manifest.json` via about:debugging
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint with `--max-warnings 0` (warnings fail; Prettier runs separately via `pnpm format`)
- `pnpm test` — Vitest (unit + component)
- `pnpm test:e2e` — Playwright E2E
