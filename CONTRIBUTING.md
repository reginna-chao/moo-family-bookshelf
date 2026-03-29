# Contributing to MooFamily Bookshelf

Thank you for your interest in contributing! This guide covers the development setup, workflow, and conventions for the project.

## Development Setup

### Prerequisites

- **Node.js** 20+
- **pnpm** 9+
- **Git**

### Clone & Install

```bash
git clone https://github.com/reginna-chao/moo-family-bookshelf.git
cd moo-family-bookshelf
pnpm install
```

### Environment Variables

Each sub-project provides an `.env.example` template. Copy and adjust as needed:

```bash
cp extension/.env.example extension/.env.production
cp extension/.env.example extension/.env.development
cp pwa/.env.example pwa/.env.production
cp pwa/.env.example pwa/.env.development
```

- `.env.development` — Local dev mode, typically set API to `http://localhost:8787`
- `.env.production` — Production build, uses the default or self-hosted Worker URL
- Self-hosters: set `VITE_API_ENDPOINT` to your own Worker URL

## Project Structure

| Directory | Description |
|-----------|-------------|
| `extension/` | Chrome Extension (React + TypeScript + Vite) |
| `pwa/` | PWA mobile viewer (React + Vite) |
| `worker/` | Cloudflare Workers backend (Hono + KV) |
| `site/` | GitHub Pages landing page |
| `docs/` | Project documentation (plan, architecture, privacy) |
| `assets/brand/` | Brand assets (logo, favicon, OG image) |

### Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React + TypeScript + Vite | Chrome Extension, Dialog injected via Content Script |
| Mobile | PWA | Shares the same Workers API; cannot scrape Readmoo |
| Backend | Cloudflare Workers | Serverless; free tier sufficient; self-hostable |
| Storage | Cloudflare KV | `user:{id}` for personal settings, `family:{id}` for groups |
| Encryption | Web Crypto API (AES-256-GCM) | E2EE; server stores ciphertext only |

## Development Commands

### Extension

```bash
cd extension
pnpm dev        # Dev server (API points to localhost:8787)
pnpm build      # Production build (API points to prod Worker)
pnpm typecheck  # Type check
pnpm lint       # ESLint + Prettier
pnpm test       # Unit + component tests
```

### Worker

```bash
cd worker
pnpm dev        # Local dev (Miniflare + preview-kv)
pnpm build      # Build
pnpm typecheck  # Type check
pnpm test       # Unit + integration tests (Vitest + Miniflare)
```

### PWA

```bash
cd pwa
pnpm dev
pnpm build
pnpm typecheck
pnpm test
```

### Dev vs Production

| Mode | Commands | API Endpoint | KV |
|------|----------|-------------|-----|
| Dev | `cd worker && pnpm dev` + `cd extension && pnpm dev` | `localhost:8787` | preview-kv |
| Prod | `cd extension && pnpm build` | prod Worker | prod-kv |

Run Worker and Extension in separate terminals during development. Data writes go to preview-kv, keeping the production environment clean.

## E2E Testing

E2E tests use Playwright to load the built Chrome Extension and run full-flow tests against a simulated Readmoo page.

```bash
pnpm test:e2e   # Builds Extension + starts local Worker + runs all E2E tests
```

First-time setup — install the Playwright browser:

```bash
cd extension && npx playwright install chromium
```

### Test Scenarios

| Spec file | Coverage |
|-----------|----------|
| `family-lifecycle.spec.ts` | Create family → sync code → second user joins → verify members |
| `book-sharing.spec.ts` | Books default to not-shared → toggle → save → visible in family shelf |
| `dialog-state-machine.spec.ts` | No family → onboarding → create → main view → close/reopen persistence |
| `custom-endpoint.spec.ts` | Custom API endpoint → sync code with `@host` → format validation |

### Selector Verification

E2E tests rely on mock HTML that simulates the Readmoo DOM. When Readmoo updates their page structure, verify that `scraper.ts` selectors still work:

```bash
pnpm e2e:verify:selectors          # Check all selectors against live Readmoo
pnpm e2e:verify:selectors:update   # Check + regenerate mock HTML from live DOM
```

The first run opens Chromium and requires manual Readmoo login. Login state is persisted for subsequent runs.

## Testing Conventions

- Test **business behavior**, not implementation details.
- New features must include corresponding tests.
- Tests must clean up state (no leaked timers, mocks, listeners, or KV entries).
- Integration tests use Miniflare to simulate KV — never connect to real Cloudflare in tests.
- E2E tests load the built Extension into a real Chrome instance via Playwright.

### Coverage Targets

| Scope | Target |
|-------|--------|
| `extension/src/crypto/` | ≥ 90% |
| `extension/src/api/` | ≥ 80% |
| `extension/src/dialog/` | ≥ 70% |
| `worker/src/` | ≥ 80% |
| Overall | ≥ 70% |

Run full coverage report:

```bash
pnpm test:coverage
```

## Code Style

- **TypeScript**: strict mode, no `any`. Use `unknown` + type guards when needed.
- **React**: functional components + hooks. No class components.
- **CSS**: Tailwind CSS utility classes.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for components/types, `UPPER_SNAKE` for constants.
- **Language**: English for code identifiers; 繁體中文 for UI text.
- Keep files under 300 lines. Split when it improves clarity.

## Pull Requests

### Branch Naming

Use descriptive branch names:

- `feat/add-book-search` — New feature
- `fix/sync-code-parsing` — Bug fix
- `docs/update-privacy-policy` — Documentation
- `refactor/extract-crypto-utils` — Refactoring

### Commit Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add personal shelf search
fix: correct sync code parsing for custom endpoints
docs: update self-hosting guide
refactor: extract shared validation helpers
test: add crypto roundtrip tests
chore: update dependencies
```

### PR Workflow

1. Fork the repo and create a feature branch
2. Develop and write tests
3. Ensure all checks pass:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   cd worker && pnpm test
   ```
4. Submit a PR describing the changes and motivation

### CI Checks

Every push/PR triggers:

- ESLint + Prettier formatting
- TypeScript type checking
- Unit + component tests
- E2E tests (on PR to `main`)

## Security Notes

- All book data defaults to not-shared; users must explicitly opt-in.
- Data is encrypted client-side (AES-256-GCM) before upload.
- Never hardcode keys or sensitive information in source code.
- `.env`, `.dev.vars`, and similar files must not be committed to git.
- Content Script only reads publicly visible book information — never touch account credentials.

## Self-Hosting

To deploy your own Cloudflare Worker backend:

1. See [worker/DEPLOY.md](worker/DEPLOY.md) for the deployment guide
2. Set your Worker URL in Extension / PWA settings
3. The sync code automatically includes the API endpoint via the `@host` format

## Reporting Issues

Please use [GitHub Issues](https://github.com/reginna-chao/moo-family-bookshelf/issues) to report bugs or suggest features.

## License

This project is released under the [MIT License](LICENSE). By submitting a PR, you agree to license your contribution under the same terms.
