# Repository Guidelines

- Repo: `moo-family-bookshelf`
- Language: 繁體中文 for user-facing content (UI, docs, comments, and ALL assistant/bot replies — chat, PR, and issue comments), English for code identifiers and commit messages.
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
│   │   ├── config/             # Readmoo host/selector config, report links
│   │   ├── icons/              # Inline brand SVG paths
│   │   ├── invite/             # Invite message templates
│   │   └── personal/           # Personal-shelf save strategy (PUT vs PATCH)
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
│       └── cicd.yml            # CI (lint/typecheck/test/build) + CD (Worker/PWA/Pages deploy, Release)
├── AGENTS.md                    # This file
└── CLAUDE.md                    # → AGENTS.md
```

### The `shared/` package

`moo-family-bookshelf-shared` 是 workspace 內的純 TypeScript 原始碼套件，沒有 build 步驟——`extension/` 與 `pwa/` 都直接以 `moo-family-bookshelf-shared/<entry>` import 原始碼，由各自的 Vite 打包。存放兩端必須完全一致的邏輯（Readmoo 設定、邀請訊息、個人書櫃儲存策略等），避免同一份規則在兩邊各寫一次而漂移。

- **不得依賴任何 runtime 專屬 API。** `shared/` 除了被瀏覽器端 import，也被 `extension/scripts/` 底下以 `tsx` 執行的 Node 腳本 import。`tsconfig.json` 雖含 `DOM` lib（`URLSearchParams` 型別所需），但 `eslint.config.js` 以 `no-restricted-globals` 擋掉 `document` / `window` / `localStorage` / `sessionStorage` / `navigator`，讓這條界線由靜態檢查保證。
- **CI 覆蓋**：`shared/` 有自己的 `lint` / `typecheck` script，在 CI 的 `extension-check` job 內執行（`shared/**` 已在該 job 的 path filter 內）。新增檔案不需額外設定即被檢查。
- **測試**：`shared/` 本身沒有 test script，其行為由 `extension/tests/` 與 `pwa/tests/` 涵蓋。

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
- Tests (extension, specific): `pnpm test -- tests/unit/crypto`
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

- `extension-check`: lint → typecheck → test → build。**也負責 `shared/` 的 lint 與 typecheck**（`shared/**` 已在此 job 的 paths-filter 內；掛在既有 job 可避免動到 `ci-success` 的 `needs` 而讓 gate 靜默放行）
- `worker-check`: lint → typecheck → test → build
- `pwa-check`: lint → typecheck → test → build
- `e2e` (PR to `main` only): build extension + start Miniflare + Playwright E2E
- `pwa-e2e` (PR to `main` only): PWA Playwright E2E

### CD (GitHub Actions)

| Trigger                             | Action                                    |
| ----------------------------------- | ----------------------------------------- |
| Merge to `main` + `worker/` changed | `wrangler deploy`                         |
| Merge to `main` + `site/` changed   | Deploy GitHub Pages                       |
| Merge to `main` + `pwa/` changed    | Deploy PWA to Cloudflare Pages            |
| Git tag `v*`                        | Build Extension → `.zip` → GitHub Release |

GitHub Release 內容：release job 會讀取 `docs/release-notes/v<X.Y.Z>.md`（雙語策展內容）放到 Release 正文最上方，並自動把 commit 清單收進 `<details>` 折疊區、補上 Full Changelog。此檔由 `/bump-ver` 產生，必須存在於 tag 指向的 commit；缺檔時 release job 會 fallback 成自動 commit 清單並印 `::warning::`。**先 `/bump-ver` 再打 tag**，順序顛倒會走 fallback。

### Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

### Dev Script Maintenance Note

`extension/package.json` 的 `dev` 和 `dev:remote` 使用明確的 `concurrently` 列表而非 `pnpm:dev:*` 通配符，以避免 `dev:remote:*` 子腳本被重複抓取。新增 Vite 入口（新的 content script 或 vite config 檔案）時，需同步更新 `dev` 和 `dev:remote` 兩個腳本的列表。

## Coding Style

- Language: TypeScript (ESM). Strict typing; avoid `any`.
- UI components: React functional components with hooks.
- Naming: `camelCase` for variables/functions, `PascalCase` for components/types, `UPPER_SNAKE` for constants.
- Keep files concise; aim for under 300 LOC per file. Split when it improves clarity.
- Add brief comments for non-obvious logic only; do not over-comment.
- CSS: Tailwind CSS utility classes preferred. Avoid inline styles for complex layouts.

### Boolean Convention

- All boolean-like fields in API payloads and KV storage **must** use the `BoolFlag` enum, never `true | false` or raw `0 | 1` literals.
- `BoolFlag` is defined in both `extension/src/api/client.ts` and `pwa/src/api/client.ts`:
  ```typescript
  export enum BoolFlag {
    FALSE = 0,
    TRUE = 1,
  }
  ```
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
│   └── security-ux-invariants.md
├── agents/         # role agents (invisible in the slash menu)
│   ├── coder.md  tester.md  reviewer.md  security-auditor.md  designer.md
│   └── references/designer/{pencil-mockup,logo,icon,banner}.md
├── reports/        # retro reports — written by /develop's retro offer, consumed & cleared by /distill
└── skills/         # slash-menu entries
    ├── develop/        # SKILL.md (router) + references/{code-cycle,design,retro}.md
    ├── distill/        # fold retro reports into durable rules, then clear them
    ├── bump-ver/
    └── project-init/
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

### Retro → Distill 自我改善迴圈

- **Retro（產報告）**：每次 `/develop` run 收尾時**問一次**是否做 retrospective（使用者決定，
  絕不自動跑）。同意後在主 session 依 `develop/references/retro.md` 產出
  `.claude/reports/<MMDD_HHMM>.md` — 只寫結論（卡點、改進提案 L#/E#、KPI），**不套用任何提案**。
- **Distill（蒸餾）**：報告累積數份後，由使用者定期呼叫 `/distill` — 彙整所有報告的提案、
  跨報告重現的教訓優先、逐項由使用者決定採納與否，套用到 `.claude/rules/`、skills、agents、
  `AGENTS.md` 等 git-tracked 目標，最後清除已消化的報告。報告是揮發性原料，規則檔才是持久產物。

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
