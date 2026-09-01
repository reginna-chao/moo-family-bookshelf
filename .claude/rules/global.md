## Global Development Rules

### Language

- Code identifiers, commit messages, branch names: English.
- User-facing content (UI, docs, comments in docs, and ALL assistant/bot replies in chat / PR / issue comments): 繁體中文.
- Code comments: English for technical, 繁體中文 acceptable for business logic explanations.

### Git Hygiene

- Always `git add` new files before committing (except `.env`, `.dev.vars`, secrets).
- Follow conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Run `pnpm lint` and `pnpm test` before pushing.

#### Branch & Worktree Hygiene

- **Branch fresh from `origin/main` by default.** Unless the user explicitly names a base or asks you to continue an existing branch, start every task by `git fetch origin` then branching from `origin/main`. Never build your change on top of whatever branch/worktree happens to be checked out.
- **Never inherit another task's commits.** Before your first commit, confirm `git log --oneline origin/main..HEAD` contains only your own work. If the current worktree/branch already carries unrelated in-progress commits (another feature, a stale worktree), do NOT stack on it — cut a fresh branch from `origin/main` first. This is what stops an unrelated commit from leaking into your PR diff.
- **Name branches meaningfully:** `<type>/<short-kebab-slug>`, where `<type>` is a conventional-commit category (`feat` / `fix` / `refactor` / `docs` / `test` / `chore`) and the slug concisely describes the task in English (e.g. `fix/dropdown-scroll-dismiss`, `refactor/security-auditor`). Do NOT keep an opaque auto-generated worktree name like `claude/angry-moore-3651ca` — rename to a meaningful branch before committing / opening the PR.

### Windows Environment Pitfalls

- **CRLF false positives**: with `core.autocrlf=true`, `prettier --check` can flag untouched files. Confirm with `diff --strip-trailing-cr` (or a `git diff` showing no content change) and leave untouched files alone — never "fix" files you didn't edit.
- **Edit can rewrite EOLs**: the Edit tool intermittently rewrites a whole file to CRLF. After editing, check EOL (git's CRLF warning / `prettier --check` on that file) and convert back to LF if tripped.
- **CJK files: Edit tool only**: sed/perl one-liners silently corrupt non-ASCII content; reserve stream editors for pure-ASCII mechanical changes.
- **cwd does not persist**: every git/verify command starts with `cd "<absolute worktree root>" && …` (Bash) or an absolute path (PowerShell) — never rely on a previous call's directory. If the Bash tool's PATH lacks git, run git via PowerShell.
- **Split long verifications**: run typecheck / lint / test as separate calls so the 2-minute default timeout can't truncate them; when piping test output, capture to a file — `| tail` / `| grep` can swallow the failure status line.

### Self-Improvement

- When file architecture changes, update corresponding `.claude/rules/*.md` to reflect new structure.
- When adding new patterns or conventions, update `AGENTS.md` accordingly.

### File References

- Always use repo-root relative paths (e.g., `extension/src/dialog/FamilyShelf.tsx:42`).
- Never use absolute paths in chat or documentation.

### Code Quality

#### Architecture

- Single Responsibility: each function, module, and class does one thing. If a name needs "and" to describe it, split it.
- Explicit layering: separate entry points (handlers, controllers, event listeners) from business logic from data access. Do not mix concerns in a single function.
- Depend on abstractions, not concretions. When a module directly depends on a specific external service, isolate that dependency behind an interface or adapter.
- Prefer composition over inheritance.
- No god functions: if a function exceeds ~40 lines, it is likely doing too much. Extract sub-steps.

#### Performance

- No redundant I/O: never read the same data source (DB, API, file) multiple times in a single request/operation when one read suffices.
- Batch over loop: when accessing external resources inside a loop, batch them into a single operation. Avoid N+1 patterns.
- No unnecessary recomputation: if a value is expensive to compute and used more than once, compute it once and reuse.
- Measure before optimizing: do not add caching, memoization, or complexity for performance unless there is evidence of a bottleneck.

#### Lifecycle & Resource Cost

The Performance principles above govern _intra-request_ efficiency. These rules govern _long-running_ and _recurring_ cost — the kind that quietly burns budget while no human is watching.

- **On-demand over preemptive**: For features with non-trivial cost (network requests, KV writes, heavy computation), default to executing on user action — not on mount, not on a schedule. Preemptive execution is only justified when (a) the user cannot tolerate the latency of a fresh fetch, (b) data must stay consistent with an external source in real time, or (c) the work serves a race-against-time UX (e.g., notification arriving while user is away). Most CRUD-style features do not meet this bar.
- **Match cadence to user need, not to TTL**: The frequency of a periodic operation must mirror how often the user actually needs it, not how often the underlying token / cache / data expires. A QR code that a user generates once a month does not need a 4-minute refresh timer just because the token has 5-minute TTL — generate it on click, mark expired in UI, regenerate on click.
- **Cost the worst case before merging**: Before introducing any `setInterval`, recurring `setTimeout`, polling loop, or background sync, mentally simulate one user with this UI open for 8h / 24h / 7d, multiplied by realistic concurrent users. Compare against the platform's free tier (e.g., Cloudflare Workers ~100,000 req/day). **If the worst case exceeds 1,000 requests per user per day, the design is wrong — switch to user-triggered or visibility-gated.**
- **Background-tab idle**: For any timer that lives across tab visibility changes, decide explicitly whether it should pause when hidden. The default answer is _yes_; a timer polling in a background tab for 24 hours is almost always a bug.
- **Cleanup completeness**: Every resource acquired (timer, listener, subscription, abort controller) must have a matching cleanup on the unmount / disconnect / error path. Already covered under Side Effects, restated here because lifecycle bugs and resource bugs share a root cause.

#### Side Effects

- Side effects must be explicit and centralized. A function that modifies external state should make that obvious from its name and signature.
- Entry in, cleanup out: every side effect that acquires a resource (listener, timer, connection, subscription) must have a corresponding cleanup path.
- No hidden state mutation: middleware, decorators, and utility functions must not silently modify shared state.
- Isolate impure code: push side effects to the edges of the system. Keep core business logic pure.
- Error paths must also clean up: if a function fails partway through, any side effects already performed must be rolled back or cleaned up.

#### Data Access

- Define a clear data access layer. Application logic should not contain raw queries or direct storage API calls scattered throughout.
- Validate at system boundaries: validate all external input at the point of entry. Internal code can trust validated data.
- Do not over-fetch: request only the data you need.

### Decision Framework

Testability > Readability > Simplicity > Consistency > Performance > Maintainability

### Code Modification Workflow (Mandatory)

Any code modification — **regardless of size** — must go through this cycle, in one of its two sanctioned forms:

1. **Write** (coder agent) → 2. **Typecheck** → 3. **Test** (tester agent, where applicable) → 4. **Review** (reviewer agent) → 5. **Fix cycle** for any CRITICAL findings → 6. **Report** to user

**Two sanctioned forms.** The workflow runs in one of two forms. The **full cycle** (default) is the complete `/develop` lifecycle around the sequence above. **Fix mode** is the lightweight form defined in `.claude/skills/develop/references/code-cycle.md` → "Mode Selection: fix mode vs full cycle" — available only when ALL of that section's mechanical eligibility conditions hold (single scope; no API-contract / KV-schema change; production diff ≤ 40 lines measured against the run's merge-base, test trees excluded; no security-sensitive path touched). Fix mode still runs coder → verify → one regression test → CRITICAL-only review; eligibility is re-measured after every coder return (Fix-Cycle rounds included), and a violated condition escalates the run in place to the full cycle.

"Size too small" is NEVER a valid reason to skip review. A one-line fix is subject to the same cycle as a 500-line feature — at most it qualifies for fix mode, which reduces ceremony but still reviews. The cost of an extra review round is trivial; the cost of silently shipping unreviewed code is not.

**Only exceptions:**

- Pure typo fixes in user-facing strings (note: these may still break tests and should be verified).
- Pure comment / doc changes that touch no executable code.
- The user explicitly authorizes bypass for a specific task with a phrase such as "skip review", "just write the code", or "no need for the full workflow". Absent such explicit instruction, the cycle is mandatory.

**Enforcement route:**

- `/develop` is the single entry. On a CODE-intent request it runs the full lifecycle (`requirements → coder → tester → review → fix`) in one session, dispatching the `coder` / `tester` / `reviewer` / `security-auditor` agents (each scoped `frontend` or `backend`). It holds every user gate itself.
- The Fix Cycle lives in `/develop` (`references/code-cycle.md`). The `coder` / `tester` / `reviewer` agents are dispatched ONLY by `/develop`'s orchestration — invoking an implementation agent in a way that skips the cycle is prohibited.
- If the user dispatches a single agent directly (e.g. just a `coder`), follow that agent's own scope — but still run `pnpm typecheck` and report any lint/type issues before finishing.

**Self-check before the final report:** ask yourself "did I skip review because the change was small?" If yes, go back and run review. No exceptions.
