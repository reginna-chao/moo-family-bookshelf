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

`.env.example` contains dev defaults. Copy to `.env` to start developing:

```bash
cp .env.example .env
```

- `.env` — gitignored, personal dev config
- `.env.production` — committed, prod URLs **only** (no secrets; see [Security Notes](#security-notes))
- `.env.example` — committed, dev defaults template

## Project Structure

| Directory       | Description                                         |
| --------------- | --------------------------------------------------- |
| `extension/`    | Chrome Extension (React + TypeScript + Vite)        |
| `pwa/`          | PWA mobile viewer (React + Vite)                    |
| `worker/`       | Cloudflare Workers backend (Hono + KV)              |
| `site/`         | GitHub Pages landing page                           |
| `docs/`         | Project documentation (plan, architecture, privacy) |
| `assets/brand/` | Brand assets (logo, favicon, OG image)              |

### Tech Stack

| Layer    | Technology                | Notes                                                       |
| -------- | ------------------------- | ----------------------------------------------------------- |
| Frontend | React + TypeScript + Vite | Chrome Extension, Dialog injected via Content Script        |
| Mobile   | PWA                       | Shares the same Workers API; cannot scrape Readmoo          |
| Backend  | Cloudflare Workers        | Serverless; free tier sufficient; self-hostable             |
| Storage  | Cloudflare KV             | `user:{id}` for personal settings, `family:{id}` for groups |

## Development Commands

### Extension

```bash
cd extension
pnpm dev                  # Dev server (API points to localhost:8787)
pnpm build                # Production build (API points to prod Worker)
pnpm typecheck            # Type check
pnpm lint                 # ESLint + Prettier
pnpm test                 # Unit + component tests
pnpm build:firefox        # Build both Firefox variants (dist-firefox-amo/ + dist-firefox-direct/)
pnpm build:updates-json   # Generate the Firefox self-distribution updates.json
pnpm lint:firefox         # web-ext lint both Firefox variants
```

> The `amo` variant omits `update_url` (an AMO listing requirement), while the `direct` variant includes it so self-distributed `.xpi` installs auto-update via `updates.json`.

### Worker

```bash
cd worker
pnpm dev          # Local dev (Miniflare local KV)
pnpm dev:remote   # Local dev (remote dev KV)
pnpm build        # Build (dry-run, prod config)
pnpm typecheck    # Type check
pnpm test         # Unit + integration tests (Vitest + Miniflare)
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

From the project root:

| Script             | Worker           | KV              | Use case          |
| ------------------ | ---------------- | --------------- | ----------------- |
| `pnpm dev`         | `localhost:8787` | Local Miniflare | Daily development |
| `pnpm dev:remote`  | `localhost:8787` | Remote dev KV   | Test with real KV |
| `pnpm deploy:prod` | Cloudflare       | Prod KV         | Deploy production |

Utility scripts:

| Script              | Description                   |
| ------------------- | ----------------------------- |
| `pnpm clean:kv`     | Clear local Miniflare KV data |
| `pnpm clean:kv:dev` | Clear remote dev KV data      |

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

| Spec file                      | Coverage                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| `family-lifecycle.spec.ts`     | Create family → sync code → second user joins → verify members         |
| `book-sharing.spec.ts`         | Books default to not-shared → toggle → save → visible in family shelf  |
| `dialog-state-machine.spec.ts` | No family → onboarding → create → main view → close/reopen persistence |
| `custom-endpoint.spec.ts`      | Custom API endpoint → sync code with `@host` → format validation       |

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

| Scope                   | Target |
| ----------------------- | ------ |
| `extension/src/crypto/` | ≥ 90%  |
| `extension/src/api/`    | ≥ 80%  |
| `extension/src/dialog/` | ≥ 70%  |
| `worker/src/`           | ≥ 80%  |
| Overall                 | ≥ 70%  |

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

## Versioning

Versions are managed by the `/bump-ver` Claude Code skill — there are no per-PR
changeset files to add. Contributors just land their feature/fix commits with
[Conventional Commits](https://www.conventionalcommits.org/) prefixes; the
CHANGELOG and version bump happen later, at release time, in one step.

All five version files are kept in sync to the same number:

| File                             |
| -------------------------------- |
| `extension/package.json`         |
| `pwa/package.json`               |
| `worker/package.json`            |
| `extension/public/manifest.json` |
| `package.json` (root)            |

### Releasing a New Version

When ready to release, invoke the skill from Claude Code:

```
/bump-ver minor        # or: patch / major / an explicit x.y.z
```

It bumps the five version files, drafts a 繁體中文 `CHANGELOG.md` entry from the
commits since the last tag, and (after a single confirmation) commits the
result. Review the drafted entry before approving.

Then tag manually and push the tag — the CD workflow builds the extension and
publishes the GitHub Release:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

> **Do not manually edit version numbers** in any `package.json` or
> `manifest.json`, and do not hand-write `CHANGELOG.md` entries. Always go
> through `/bump-ver` so all five files and the changelog stay in sync.

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
- Data is protected by TLS in transit and auth tokens for access control.
- Never hardcode keys or sensitive information in source code.
- `.env`, `.dev.vars`, and files containing secrets must not be committed to git.
- **`.env.production` policy**: this file IS committed, but only because it contains values that will ship inside the public bundle anyway (production API endpoint, PWA URL). **Never** add API keys, tokens, analytics/Sentry DSNs, or any other secret to `.env.production`. If you need to inject a secret at build time, use GitHub Actions Secrets and write them to `.env.production` during the CI build step. For Worker runtime secrets, use `wrangler secret put` (see [worker/DEPLOY.md](worker/DEPLOY.md)).
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
