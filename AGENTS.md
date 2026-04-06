# Repository Guidelines

- Repo: `moo-family-bookshelf`
- Language: 繁體中文 for user-facing content (UI, docs, comments), English for code identifiers and commit messages.
- In chat replies, file references must be repo-root relative only (example: `extension/src/dialog/FamilyShelf.tsx:42`); never absolute paths.

## Project Overview

MooFamily Bookshelf is a Chrome Extension that injects a Dialog into the Readmoo (讀墨) web interface, allowing family account members to browse each other's shared books. All interactions happen via Dialog overlays — no new routes/pages are created.

Key design decisions:
- **Privacy first**: all books default to not-shared; users opt-in per book.
- **Personal settings persist across families**: sharing preferences are tied to the user, not the family group. Unbinding from a family does not reset settings.
- **Family is a prerequisite**: the Dialog shows an onboarding screen until the user creates or joins a family.
- **Child accounts excluded**: Readmoo child accounts cannot use the web interface, so they are out of scope.

## Project Structure

```
moo-family-bookshelf/
├── docs/                        # Project documentation (plans, architecture, privacy)
│   ├── project-plan.md
│   ├── architecture.md
│   └── privacy-policy.md
├── extension/                   # Chrome Extension source
│   ├── src/
│   │   ├── dialog/              # Dialog UI (React) — injected into Readmoo pages
│   │   │   ├── Onboarding.tsx       # Gate screen: create/join family
│   │   │   ├── PersonalShelf.tsx    # Per-book share toggle
│   │   │   ├── FamilyShelf.tsx      # Aggregated family bookshelf
│   │   │   └── FamilySettings.tsx   # Sync code, members, leave family
│   │   ├── settings/            # Extension settings (custom API endpoint, etc.)
│   │   ├── content/             # Content Script (scrape book list + inject Dialog)
│   │   ├── background/         # Service Worker
│   │   ├── crypto/             # E2EE module (Web Crypto API, AES-256-GCM)
│   │   └── api/                # API client (configurable endpoint)
│   ├── tests/
│   │   ├── unit/              # Unit tests (crypto, api, utils)
│   │   ├── component/        # Component tests (React Testing Library)
│   │   └── e2e/              # E2E tests (Playwright + Extension)
│   ├── public/
│   │   └── manifest.json       # Manifest V3
│   ├── vitest.config.ts
│   ├── playwright.config.ts
│   ├── vite.config.ts
│   └── package.json
├── worker/                      # Cloudflare Workers backend (self-hostable)
│   ├── src/
│   │   └── index.ts
│   ├── tests/
│   │   ├── unit/              # Unit tests (routes, middleware)
│   │   └── integration/      # Integration tests (Miniflare + KV)
│   ├── vitest.config.ts
│   ├── wrangler.toml
│   └── DEPLOY.md               # Self-hosting guide
├── pwa/                         # PWA mobile viewer (Phase 3)
├── site/                        # GitHub Pages landing page
│   └── index.html
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI: lint + typecheck + test + build
│       └── cd.yml              # CD: Worker deploy / Pages deploy / Release
├── AGENTS.md                    # This file
└── CLAUDE.md                    # → AGENTS.md
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React + TypeScript + Vite | Chrome Extension, Dialog injected via Content Script |
| Mobile | PWA | Shares the same Workers API; cannot scrape Readmoo |
| Backend | Cloudflare Workers | Serverless; free tier sufficient; self-hostable |
| Storage | Cloudflare KV | `user:{id}` for personal settings, `family:{id}` for groups |
| Encryption | Web Crypto API (AES-256-GCM) | E2EE; server stores ciphertext only |

## Build & Development Commands

- Runtime: Node 20+
- Install deps: `pnpm install`
- Dev (extension): `pnpm dev`
- Build (extension): `pnpm build`
- Type check: `pnpm typecheck`
- Lint/format: `pnpm lint` / `pnpm format`
- Tests (extension): `pnpm test`
- Tests (extension, specific): `pnpm test -- tests/unit/crypto`
- Tests (worker): `cd worker && pnpm test`
- Tests (e2e): `pnpm test:e2e`
- Worker dev: `cd worker && wrangler dev`
- Worker deploy: `cd worker && wrangler deploy`

## Testing

### Framework & Tools

| Tool | Scope | Purpose |
|------|-------|---------|
| Vitest | Extension + Worker | Unit & integration tests |
| React Testing Library | Extension | Component tests for Dialog UI |
| Playwright | Extension | E2E tests with Chrome Extension loaded |
| Miniflare | Worker | Local Cloudflare Workers + KV simulation |

### Test Structure

- Extension tests: `extension/tests/{unit,component,e2e}/`
- Worker tests: `worker/tests/{unit,integration}/`
- Tests colocated by type, not by source file.

### Conventions

- Run `pnpm test` before pushing; CI will gate on this.
- Coverage targets: crypto ≥ 90%, api/worker ≥ 80%, dialog ≥ 70%, overall ≥ 70%.
- Tests must clean up state (no leaked timers, mocks, or KV entries).
- Integration tests use Miniflare to simulate KV locally — never connect to real Cloudflare in CI.
- E2E tests load the built Extension into a real Chrome instance via Playwright.

### Key Test Scenarios

- **Crypto**: encrypt → decrypt roundtrip, key generation, sync code encode/decode (with/without `@host`).
- **Dialog state machine**: no family → onboarding, has family → main view, unbind → back to onboarding.
- **Personal shelf**: all books default to not-shared, toggle works, save-before-sync enforced.
- **Family lifecycle** (Worker): create → join → query → leave → query excludes former member.
- **Permission isolation** (Worker): non-member cannot access family bookshelf or modify others' settings.

## CI/CD

### CI (GitHub Actions)

Every push/PR triggers:
- `extension-check`: lint → typecheck → test → build
- `worker-check`: lint → typecheck → test → build
- `e2e` (PR to `main` only): build extension + start Miniflare + Playwright E2E

### CD (GitHub Actions)

| Trigger | Action |
|---------|--------|
| Merge to `main` + `worker/` changed | `wrangler deploy` |
| Merge to `main` + `site/` changed | Deploy GitHub Pages |
| Merge to `main` + `pwa/` changed | Deploy PWA to Cloudflare Pages |
| Git tag `v*` | Build Extension → `.zip` → GitHub Release |

### Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

## Coding Style

- Language: TypeScript (ESM). Strict typing; avoid `any`.
- UI components: React functional components with hooks.
- Naming: `camelCase` for variables/functions, `PascalCase` for components/types, `UPPER_SNAKE` for constants.
- Keep files concise; aim for under 300 LOC per file. Split when it improves clarity.
- Add brief comments for non-obvious logic only; do not over-comment.
- CSS: Tailwind CSS utility classes preferred. Avoid inline styles for complex layouts.

## Data Model

Two-layer data architecture:

1. **Personal sharing settings** (`user:{user_id}`) — per-user, persists across family changes.
   - Contains: book list with per-book `is_shared` flag, display name, last updated timestamp.
   - All books default to `is_shared: false`. New purchases also default to false.
   - Changes require explicit "save" action before syncing to server.

2. **Family group** (`family:{family_id}`) — list of member user IDs.
   - Family bookshelf is a dynamic aggregation query, not stored independently.
   - Reverse lookup: `member:{user_id}` → `family_id`.

## Sync Code Format

```
moo-{family_id_short}-{encryption_key_encoded}            # default API
moo-{family_id_short}-{encryption_key_encoded}@{host}     # custom API endpoint
```

The `@host` segment auto-configures the API endpoint for invited members, ensuring all family members use the same backend.

## Dialog State Machine

```
Open Dialog → has family_id?
  No  → Onboarding (create / join family)
  Yes → Main view (tabs: Family Shelf | Personal Shelf | Settings)
```

Family membership is the gate for all features. Without a family, only onboarding is accessible.

## API Endpoints

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/lookup` | Look up family membership by pre-hashed userId |
| `POST` | `/api/auth/refresh` | Refresh auth token (uses userId + familyId membership) |

### Personal Settings
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/user/:id/books` | Get personal book list + sharing settings |
| `PUT` | `/api/user/:id/books` | Update sharing settings |

### Family Group
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/family` | Create new family group |
| `POST` | `/api/family/:id/join` | Join family with sync code |
| `DELETE` | `/api/family/:id/member/:uid` | Leave family |
| `GET` | `/api/family/:id/members` | List family members |

### Family Bookshelf
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/family/:id/bookshelf` | Aggregated shared books from all members |

## Security & Privacy Rules

- **E2EE**: all data encrypted in browser before upload. Server is zero-knowledge.
- **Default closed**: every book defaults to not-shared. Never auto-share.
- **Save to sync**: changes only upload after explicit save action.
- **Unbind isolation**: leaving a family immediately removes user from member list; other members can no longer see their books.
- **Settings persist**: personal sharing preferences survive family unbind/rebind.
- **No PII collection**: no accounts, no email, no tracking.
- Never commit secrets, API keys, or `.dev.vars` / `.env` files.
- Content Script only reads publicly visible book information from the Readmoo page; never touch account credentials.

## Configurable API Endpoint (BYO Backend)

- Extension and PWA both support custom API endpoint URL in settings.
- Default: project's public Cloudflare Worker.
- Self-hosters: fork `worker/`, deploy to own Cloudflare account, set URL in Extension/PWA.
- All family members must use the same endpoint. The sync code `@host` segment handles this automatically.

## Commit & PR Guidelines

- Commit messages: English, concise, action-oriented (e.g., `feat: add personal shelf toggle UI`).
- Follow conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Group related changes; avoid bundling unrelated refactors.
- Run `pnpm lint` and `pnpm test` before pushing. CI will block merges with failures.

## Documentation

- Project docs: `docs/` (architecture, plan, privacy policy).
- Self-hosting guide: `worker/DEPLOY.md`.
- Public landing page: `site/index.html` (deployed via GitHub Pages).
- Docs language: 繁體中文 for all user-facing documentation.

## Collaboration Notes

- When answering questions, verify in code first; do not guess.
- Bug investigations: read related source code before concluding.
- Do not edit `node_modules`.
- Keep `pnpm-lock.yaml` in sync when changing dependencies.
- PWA limitation: cannot scrape Readmoo book lists (no Content Script). Personal shelf management requires at least one sync from desktop Extension first.

## Final Note

I will have Gemini or other LLM review this project and report areas for improvement.
