# Repository Guidelines

- Repo: `moo-family-bookshelf`
- Language: 繁體中文 for user-facing content (UI, docs, comments, and ALL assistant/bot replies — chat, PR, and issue comments), English for code identifiers and commit messages. Agent-facing documents — this file and everything under `.claude/` — are English; the 繁中 that legitimately stays in them (strings the agent emits or matches verbatim) is defined in `.claude/rules/global.md` → Language → "The exemption".
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
│   └── architecture.md
├── shared/                      # Cross-app TypeScript library (no build step)
│   ├── src/
│   │   ├── api/                # Wire types (BoolFlag / envelope / family / personal-books / public-shelf / verify records) + endpoint URL validation + sync-code @host classification + backend data-field runtime coercion + member / bookshelf payload validation
│   │   ├── borrow/             # Borrow wire types + borrow-list payload validation + borrow-request failure copy (error code → 繁中 string)
│   │   ├── config/             # Readmoo host/selector config, report links
│   │   ├── hostNote/           # SyncCodeHostNote copy (join / verify / onboarding lead-ins)
│   │   ├── icons/              # Inline brand SVG paths
│   │   ├── invite/             # Invite message templates
│   │   ├── personal/           # Personal-shelf save strategy (PUT vs PATCH)
│   │   ├── publicShelf/        # Public-shelf local-vs-server divergence rule
│   │   └── unkick/             # Un-kick notice copy (removed / cleared / hint)
│   ├── eslint.config.js
│   ├── tsconfig.json
│   └── package.json
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
│   │   ├── crypto/             # Hashing utilities (SHA-256)
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
│       ├── cicd.yml            # CI (lint/typecheck/test/build) + CD (Worker/PWA/Pages deploy, Release)
│       ├── claude-code-review.yml # Automatic Claude review on every PR open / ready / reopen
│       └── claude.yml          # Manual @claude trigger: re-review and Q&A from a comment / issue
├── AGENTS.md                    # This file
└── CLAUDE.md                    # → AGENTS.md
```

### The `shared/` package

`moo-family-bookshelf-shared` is a source-only TypeScript package inside the workspace with NO build step — `extension/`, `pwa/` and `worker/` all import the sources directly as `moo-family-bookshelf-shared/<entry>`; the first two bundle them with their own Vite config, `worker/` with wrangler's esbuild (all three map the package via `paths` → `../shared/src/*` in their `tsconfig.json`). It holds the logic that MUST behave identically on every surface — Readmoo config and the cover-URL whitelist, invite messages, the personal-shelf save strategy, API endpoint validation and sync-code `@host` classification, API wire types (`BoolFlag` / the `{ data, error }` envelope / family and borrow records) and their boundary validation — so that one rule is never written once per surface and left to drift apart.

- **No runtime-specific API may be relied on.** Besides the browser-side importers, `shared/` is imported by the Node scripts under `extension/scripts/` that run under `tsx`. `tsconfig.json` does include the `DOM` lib (needed for `URLSearchParams` typing), so `eslint.config.js` blocks `document` / `window` / `localStorage` / `sessionStorage` / `navigator` with `no-restricted-globals` — the boundary is guaranteed by static checking, not by convention.
- **CI coverage**: `shared/` has its own `lint` / `typecheck` scripts, run inside CI's `extension-check` job (`shared/**` is already in that job's path filter), so a new file is checked with no extra wiring. `worker-check`'s path filter covers `shared/**` too, so a change to `shared/` also runs the Worker checks and a broken import cannot pass silently.
- **Tests**: `shared/` has no test script of its own; its behaviour is covered by `extension/tests/`, `pwa/tests/` and `worker/tests/`.

## Tech Stack

| Layer    | Technology                | Notes                                                       |
| -------- | ------------------------- | ----------------------------------------------------------- |
| Frontend | React + TypeScript + Vite | Chrome Extension, Dialog injected via Content Script        |
| Mobile   | PWA                       | Shares the same Workers API; cannot scrape Readmoo          |
| Backend  | Cloudflare Workers        | Serverless; free tier sufficient; self-hostable             |
| Storage  | Cloudflare KV             | `user:{id}` for personal settings, `family:{id}` for groups |

## Build & Development Commands

- Runtime: Node 20+
- Install deps: `pnpm install`
- Dev (extension + PWA, local wrangler): `pnpm dev`
- Dev (extension + PWA, deployed dev worker): `pnpm dev:remote`
- Build (extension): `pnpm build`
- Build for dev worker (extension + PWA): `pnpm build:dev`
- Build (Firefox, test/dev): `pnpm build:firefox:dev` — compiles in dev mode then transforms to Firefox; load `extension/dist-firefox-direct/manifest.json` via `about:debugging`
- Type check: `pnpm typecheck`
- Lint/format: `pnpm lint` / `pnpm format` — lint runs ESLint with `--max-warnings 0`, so warnings fail CI, not just errors
- Tests (extension): `pnpm test`
- Tests (specific file, any package): `npx vitest run <path>` from inside `extension/`, `pwa/`, or `worker/` — `pnpm test -- <path>` does NOT filter in ANY package (the `--` is swallowed and the full suite runs)
- Tests (worker): `cd worker && pnpm test`
- Tests (e2e): `pnpm test:e2e`
- Worker dev: `cd worker && wrangler dev`
- Worker deploy: `cd worker && wrangler deploy`

## Testing

### Framework & Tools

| Tool                  | Scope              | Purpose                                  |
| --------------------- | ------------------ | ---------------------------------------- |
| Vitest                | Extension + Worker | Unit & integration tests                 |
| React Testing Library | Extension          | Component tests for Dialog UI            |
| Playwright            | Extension          | E2E tests with Chrome Extension loaded   |
| Miniflare             | Worker             | Local Cloudflare Workers + KV simulation |

### Test Structure

- Extension tests: `extension/tests/{unit,component,e2e}/`
- PWA tests: `pwa/tests/{unit,component,e2e}/`
- Worker tests: `worker/tests/{unit,integration}/`
- Tests colocated by type, not by source file.

### Conventions

- Run `pnpm test` before pushing; CI will gate on this.
- Coverage targets: api/worker ≥ 80%, dialog ≥ 70%, overall ≥ 70%.
- Tests must clean up state (no leaked timers, mocks, or KV entries).
- Integration tests use Miniflare to simulate KV locally — never connect to real Cloudflare in CI.
- E2E tests load the built Extension into a real Chrome instance via Playwright.

### Key Test Scenarios

- **Crypto**: deriveUserId hashing, sync code encode/decode (with/without `@host`).
- **Dialog state machine**: no family → onboarding, has family → main view, unbind → back to onboarding.
- **Personal shelf**: all books default to not-shared, toggle works, save-before-sync enforced.
- **Family lifecycle** (Worker): create → join → query → leave → query excludes former member.
- **Permission isolation** (Worker): non-member cannot access family bookshelf or modify others' settings.

## CI/CD

### CI (GitHub Actions)

Every push/PR triggers:

- `extension-check`: lint → typecheck → test → build. **It also owns `shared/`'s lint and typecheck** (`shared/**` is in this job's paths filter; hanging them off an existing job avoids touching `ci-success`'s `needs`, which would let the gate pass silently)
- `worker-check`: lint → typecheck → test → build
- `pwa-check`: lint → typecheck → test → build
- `e2e` (PR to `main` only): build extension + start Miniflare + Playwright E2E
- `pwa-e2e` (PR to `main` only): PWA Playwright E2E

### Claude Review (GitHub Actions)

- `claude-code-review.yml`: fires a Claude review automatically on every PR (`opened` / `ready_for_review` / `reopened`; not draft, not fork), with **no paths filter** — doc and config changes are reviewed too (six dimensions; the sixth reviews the docs/config diff specifically). The model is the `opus` family alias (always the latest Opus generation); the workflow writes the resolved model id back into the review comment's footer afterwards. The review bot can only comment: `--disallowedTools` blocks `gh pr review` / `gh pr merge` / `gh pr close` plus Write / Edit, so approving and merging stay human decisions.
- `claude.yml`: triggered by tagging `@claude` in a PR / issue comment (including a reply to an inline review comment), for re-review after fixes and for questions; it runs the latest Opus through `--model opus` as well. Code suggestions go inline in the comment — the job is `contents: read` and never commits or pushes.

### CD (GitHub Actions)

| Trigger                             | Action                                    |
| ----------------------------------- | ----------------------------------------- |
| Merge to `main` + `worker/` changed | `wrangler deploy`                         |
| Merge to `main` + `site/` changed   | Deploy GitHub Pages                       |
| Merge to `main` + `pwa/` changed    | Deploy PWA to Cloudflare Pages            |
| Git tag `v*`                        | Build Extension → `.zip` → GitHub Release |

Release body: the release job reads `docs/release-notes/v<X.Y.Z>.md` (curated, bilingual) and puts it at the top of the Release, then appends the commit list inside a `<details>` block plus a Full Changelog link. That file is produced by `/bump-ver` and MUST exist in the commit the tag points at; when it is missing, the release job falls back to the auto-generated commit list and prints `::warning::`. **Run `/bump-ver` BEFORE tagging** — the other order takes the fallback.

When `CHANGELOG.md` is written: between releases, every `/develop` run writes its user-observable change into the `## 未釋出` section at the top of the file, in the same commit as the change, and **never** into an already-tagged `## vX.Y.Z` entry — a version entry is frozen the moment its tag exists. `/bump-ver` is the only step that renames `## 未釋出` to the new version heading, and it only adds bullets for commits that section does not describe yet. Full detail: `.claude/rules/user-facing-copy.md` → "Where a change is recorded".

### Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

### Dev Script Maintenance Note

`extension/package.json`'s `dev` and `dev:remote` use an explicit `concurrently` list rather than the `pnpm:dev:*` wildcard, so the `dev:remote:*` sub-scripts are not picked up twice. When adding a Vite entry (a new content script or vite config file), update the list in BOTH scripts.

## Coding Style

- Language: TypeScript (ESM). Strict typing; avoid `any`.
- UI components: React functional components with hooks.
- Naming: `camelCase` for variables/functions, `PascalCase` for components/types, `UPPER_SNAKE` for constants.
- Keep files concise; aim for under 300 LOC per file. Split when it improves clarity.
- Add brief comments for non-obvious logic only; do not over-comment.
- CSS: Tailwind CSS utility classes preferred. Avoid inline styles for complex layouts.

### Boolean Convention

- All boolean-like fields in API payloads and KV storage **must** use the `BoolFlag` enum, never `true | false` or raw `0 | 1` literals.
- On the CLIENT side `BoolFlag` is defined once, in `shared/src/api/types.ts`, and re-exported by `extension/src/api/types.ts` (and onward by `extension/src/api/client.ts`) and by `pwa/src/api/client.ts`, so every existing import path still works. The Worker keeps its OWN deliberately independent declaration in `worker/src/kv/schema.ts` (it consumes no client-side wire types from `shared/`); the two declarations must stay value-identical:
  ```typescript
  export enum BoolFlag {
    FALSE = 0,
    TRUE = 1,
  }
  ```
  That parity — and the same one for `BorrowStatus` / `BorrowRequest` (`shared/src/borrow/types.ts` vs `worker/src/kv/schema.ts`) — is pinned by the tripwire `worker/tests/unit/sharedEnumParity.test.ts`, which runs in `worker-check` for a change on EITHER side (its path filter covers `worker/**` and `shared/**`). Renumbering or adding a member on one side alone fails CI.
- This applies to: `isShared`, `isArchived`, `syncArchived`, and any future boolean flags.
- Type definitions: use `BoolFlag` (not `boolean` or `0 | 1`).
- Comparisons: use `=== BoolFlag.TRUE` or `=== BoolFlag.FALSE`.
- Toggle pattern: `value === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE`.
- Why: `true === 1` is `false` in JavaScript strict equality, causing cross-platform bugs between Extension and PWA.

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
moo-{family_id_short}            # default API
moo-{family_id_short}@{host}     # custom API endpoint
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

| Method | Path                | Description                                            |
| ------ | ------------------- | ------------------------------------------------------ |
| `POST` | `/api/auth/lookup`  | Look up family membership by pre-hashed userId         |
| `POST` | `/api/auth/refresh` | Refresh auth token (uses userId + familyId membership) |

### Personal Settings

| Method | Path                  | Description                               |
| ------ | --------------------- | ----------------------------------------- |
| `GET`  | `/api/user/:id/books` | Get personal book list + sharing settings |
| `PUT`  | `/api/user/:id/books` | Update sharing settings                   |

### Family Group

| Method   | Path                          | Description                |
| -------- | ----------------------------- | -------------------------- |
| `POST`   | `/api/family`                 | Create new family group    |
| `POST`   | `/api/family/:id/join`        | Join family with sync code |
| `DELETE` | `/api/family/:id/member/:uid` | Leave family               |
| `GET`    | `/api/family/:id/members`     | List family members        |

### Family Bookshelf

| Method | Path                        | Description                              |
| ------ | --------------------------- | ---------------------------------------- |
| `GET`  | `/api/family/:id/bookshelf` | Aggregated shared books from all members |

## Security & Privacy Rules

- **Transport security**: all data protected by TLS in transit and auth tokens for access control.
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
- Branch fresh from `origin/main` (unless continuing an existing branch) and name it `<type>/<short-kebab-slug>` — a conventional type + concise task slug (e.g. `fix/dropdown-scroll-dismiss`), never an opaque auto-generated name. Before the first commit, confirm `git log origin/main..HEAD` holds only your own work so an unrelated branch/worktree's commits don't leak into the PR. Full detail: `.claude/rules/global.md` → "Branch & Worktree Hygiene".

### Replying to the review bot

`claude-code-review.yml` auto-reviews a PR on open / ready_for_review / reopen only — it deliberately does NOT listen to `synchronize`, so **a push never re-triggers a review**. Re-review is human-triggered by tagging `@claude`, which `claude.yml` picks up from the PR comment box or an inline review-comment reply.

- **Always reply** to a review, listing each finding and how it was handled (fixed → commit sha / accepted as residual risk / declined with reason). Reply in 繁體中文, like every other bot-facing message.
- **Tagging `@claude` re-runs the review workflow** (one Actions run + token spend). It only fires from a human account — `claude.yml` guards on `sender.type != 'Bot'`, so a bot's own comment can never wake it, while a reply posted through the user's `gh` account does.
- **Ask the user before adding `@claude`** — never tag on your own initiative. Recommend it after CRITICAL / WARNING fixes where a re-check has value; say it is likely unnecessary for comment-only or NITPICK-only changes. The user decides.
- Editing an existing comment triggers nothing (`issue_comment: [created]` only) — a re-review needs a NEW comment.

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
- Out-of-scope P0/P1 found mid-task → record it with `gh issue create` — created ONLY by the session that owns the run (the `/develop` orchestrator, or the main session outside `/develop`); a dispatched agent surfaces the item in its structured return and never calls `gh` itself (tier label `P0` / `P1`; body carries the tier, exact `file:line`, the consequence of leaving it unfixed, and whether a failing check can be written; English imperative title). Labeling is best-effort — if the label cannot be attached, still create the issue and prefix the title with `[P0]` / `[P1]`. Never open a worktree for it, never spawn a follow-up task chip, never widen the current task. P2 and non-goals are not raised at all. Worktrees are only for tasks the user explicitly starts; if `gh` is unavailable or issue creation fails, list the item in the final report instead of dropping it. Full detail: `.claude/rules/change-triage.md` → "Disposition of out-of-scope P0/P1".
- PWA limitation: cannot scrape Readmoo book lists (no Content Script). Personal shelf management requires at least one sync from desktop Extension first.

## Agent Orchestration & Rules Layout (`.claude/`)

All development and design go through a **single skill entry: `/develop`**. It triages intent
(CODE vs DESIGN) and dispatches role agents — it never writes code or assets itself.

```
.claude/
├── rules/          # project rules, READ on demand by agents (not auto-magic)
│   ├── global.md       # universal architecture / performance / lifecycle / side-effects
│   ├── frontend.md     # Extension + PWA (React/TS) conventions
│   ├── backend.md      # Worker (Hono/KV) conventions
│   ├── test.md         # test framework, locations, coverage
│   ├── change-triage.md # severity gate applied before proposing any unsolicited change
│   ├── user-facing-copy.md # plain-language rules for CHANGELOG / release notes / site / UI strings
│   └── security-ux-invariants.md
├── agents/         # role agents (invisible in the slash menu)
│   ├── coder.md  tester.md  reviewer.md  security-auditor.md  designer.md
│   └── references/designer/{pencil-mockup,logo,icon,banner}.md
├── reports/        # retro reports — written by /develop's retro (offered once per run, at the commit gate), consumed & cleared by /distill
└── skills/         # slash-menu entries
    ├── develop/        # SKILL.md (router) + references/{code-cycle,design,retro}.md
    ├── distill/        # fold retro reports into durable rules, then clear them
    ├── bump-ver/
    ├── project-init/
    └── speak-human-tw/ # vendored de-AI pass (MIT, see VENDORED.md) — run AUTOMATICALLY on CHANGELOG / release-notes / UI copy per rules/user-facing-copy.md Rule 9 — never invoked by the user as part of this project's process
```

- **`coder` / `tester` / `reviewer` are abstract.** `/develop` passes `scope` (`frontend` or
  `backend`); the agent then `Read`s the matching `.claude/rules/*.md` and runs the right commands.
  The Fix Cycle (CRITICAL auto-fix / SUGGESTION decision) lives in `/develop`, not in the agents.
- **Why a top-level `.claude/rules/` here (not per-area role files):** moo is a single repo with
  just one FE/BE split, so one shared set of rules — sliced by **scope/concern** (`frontend.md`,
  `backend.md`, `test.md`, `global.md`) — has the least duplication and fits well.
- **When to switch to the monorepo layout instead:** in a multi-subproject monorepo, each
  subproject's conventions diverge too much for one shared rules set, so
  rules are **pushed down** into each subproject's own `.claude/` and sliced by **role**
  (`coder.md`, `tester.md`, `reviewer.md`); the abstract agent reads `<subproject>/.claude/<role>.md`.
  Only adopt this for moo if FE/BE/PWA conventions later diverge enough that the shared rules stop fitting.
- `.claude/rules/` is **not deprecated** and not a remote-magic feature — it is load-bearing because
  the agents explicitly read it. `.claude/settings.json` is gitignored (personal, per-developer).

### Retro → Distill self-improvement loop

- **Retro (produce the report)**: every `/develop` run ASKS ONCE, at the end, whether to write a
  retrospective — the question rides in the commit-gate AskUserQuestion batch (fix mode included, no
  extra stop). Never automatic, never asked twice in one run. On a yes, the main session follows
  `develop/references/retro.md` and writes `.claude/reports/<MMDD_HHMM>.md` — written BEFORE the
  commit so it rides along in git with the feature. It records conclusions only (friction points,
  L#/E# proposals, KPIs) and **applies no proposal**. Why the question came back to the run's end
  (2026-09-16): the report is the only process record that reaches git, and therefore the only one
  visible across machines and collaborators — "ask for it when you think of it" means, in practice,
  nobody ever does.
  The report file itself is 繁體中文; these instructions are not.
- **Distill**: once several reports have accumulated, the user periodically invokes `/distill`. It
  aggregates the proposals across all reports (a lesson recurring in more than one report ranks
  highest), takes a per-item adoption decision from the user, applies the adopted ones to
  git-tracked targets (`.claude/rules/`, skills, agents, `AGENTS.md`), and finally clears the
  consumed reports. Reports are volatile raw material; the rule files are the durable product.

## Local Agent Hooks (optional)

`.claude/hooks/block-ps-herestring.js` is a `PreToolUse` hook that guards against a Windows/PowerShell footgun: using PowerShell here-string syntax `@'...'@` inside an agent's Bash tool. bash treats the leading/trailing `@` as literal characters, silently corrupting `git commit -m` / `gh pr create --body` text (a stray `@` ends up at the start and end). The hook denies any Bash command containing both `@'` and `'@`.

The script is checked into the repo, but `.claude/settings.json` is **gitignored** (personal, per-developer). To activate the hook on your machine, add this to your local `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/block-ps-herestring.js\"",
            "shell": "bash",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Only relevant when driving an agent from a Windows/PowerShell shell; harmless to skip otherwise.

## Final Note

I will have CodeX, Gemini, or other LLM review this project and report areas for improvement.
