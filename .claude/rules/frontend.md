## Frontend Architecture Rules

Applies to: `extension/src/`, `pwa/src/`

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
```

### Coding Conventions

- Functional components with hooks. No class components.
- Props defined as `interface`, named `{Component}Props`.
- Keep files under 200 lines. Split large components.
- Extract shared logic into custom hooks (`use*.ts`).
- Max 3 levels of nesting. Use early return.
- No nested ternary operators.
- No `any` type. Use `unknown` + type guards when needed.

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
- `pnpm lint` — ESLint + Prettier
- `pnpm test` — Vitest (unit + component)
- `pnpm test:e2e` — Playwright E2E
