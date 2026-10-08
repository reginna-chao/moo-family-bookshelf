# /develop Reference: CODE Development Lifecycle

The full development lifecycle for a code change. You (the `/develop` orchestrator) run every phase in THIS session and hold every user gate yourself — dispatch the `coder` / `tester` / `reviewer` / `security-auditor` agents via the Agent tool, always passing `scope` (`frontend`, `backend` or `config`). See `SKILL.md` §1–§3 for hard rules, stop discipline, and the dispatch quick-reference.

## Mode Selection: fix mode vs full cycle

Every code change runs the Code Modification Workflow, in ONE of two sanctioned forms. **Full cycle** (Phases 0–8 below) is the default. **Fix mode** is the lightweight form — the same workflow with reduced ceremony — and is allowed ONLY when EVERY condition below holds.

The conditions are mechanical: check each one, record the answer. Never pick the mode "by judgment" — a condition that is unmet **or unknown** means full cycle.

### Fix-mode eligibility (ALL four must hold)

1. **Single scope.** The change is `frontend` OR `backend` — never both. A full-stack change is always full cycle.
2. **No contract change.** No API contract change (endpoint, method, request/response shape, error `code`) AND no KV schema change (new key pattern, changed value shape, changed TTL).
3. **Diff ≤ 40 lines, production files only.** Measure against the run's OWN base — the merge-base, never the moving tip of `origin/main` — and exclude the test trees and `CHANGELOG.md`:

   ```
   git diff --numstat $(git merge-base origin/main HEAD) -- ':(top)' ':(exclude,top)extension/tests' ':(exclude,top)pwa/tests' ':(exclude,top)worker/tests' ':(exclude,top)CHANGELOG.md'
   ```

   Sum BOTH numeric columns (added + deleted) over all rows; that total must be ≤ 40. The `top` magic prefixes keep the pathspecs repo-rooted, so the command is safe to run from ANY subdirectory — a CWD-relative `-- .` run from `worker/` (where a backend verify leaves the shell) matches nothing and silently reports 0 lines, passing the size gate by accident. When the user named a different base branch for the run, substitute it for `origin/main` in the `merge-base` call. **Why the merge-base:** it measures only THIS run's work even when `origin/main` has advanced mid-run — measuring against a moved `origin/main` would count other people's commits into the 40-line budget. **Continuing an existing branch** (e.g. a fix round after PR review): the merge-base would also count that branch's earlier commits, so substitute the HEAD recorded in Phase 0 step 10 for `$(git merge-base origin/main HEAD)`. **Why production-only:** the fix-mode regression test's own size must never flip the mode — and neither may the mandatory `## 未釋出` bullet, which is required boilerplate rather than part of the fix.

4. **No security-sensitive path touched.** No file in the diff matches ANY pattern below. The list is **path-only** — never a per-call or per-symbol judgment about what inside the file was edited:
   - `worker/src/**` — the entire Worker runtime (routes, middleware, services, utils, schemas, kv, index)
   - `extension/src/crypto/**`, `pwa/src/crypto/**`, `shared/src/crypto/**` — both ends run the same hash / sync-code logic, so the exclusion is symmetric; `deriveUserId` itself lives in `shared/src/crypto/`
   - `pwa/src/hooks/useLanding*.ts`, `pwa/src/hooks/useQrJoin.ts` — the PWA login path: verify-secret routing to `joinFamily`, the unsafe-`@host` check, and the auth-token hand-off
   - `extension/src/background/**`
   - `extension/src/dialog/PersonalShelf.tsx`, `extension/src/dialog/usePersonalBooks.ts`, `pwa/src/pages/PersonalShelfPage.tsx`, `pwa/src/hooks/usePersonalShelf*.ts`, `extension/src/api/client.ts`, `pwa/src/api/client.ts` — whole files; touching the file at all disqualifies. Both PersonalShelf surfaces are listed because Phase 6's `invariants` trigger covers the FE sharing / save-before-sync flow on EITHER surface (Inv-3 / Inv-5); on the Extension side that flow lives in the `usePersonalBooks` hook, not in the presentational component; on the PWA side it lives in the `usePersonalShelf*` hooks (load / dirty tracking / share toggles / Save upload), and the page only wires the Save button
   - `shared/src/personal/**` — the PUT/PATCH save decision shared by BOTH ends; one edit here changes save-before-sync behaviour on Extension and PWA at once
   - `.env*`, `wrangler.toml`, `.github/workflows/**`
   - any dependency manifest: `package.json` at any level, `pnpm-lock.yaml`

   A match ⇒ full cycle. No exception, at any diff size. A file split off (or moved out of) a listed file inherits the listing: add its path here — and to Phase 6's `invariants` trigger when the source is named there — in the same change.

   **Why the Worker tree is excluded WHOLE — settled, do not re-litigate (issue #146).** A narrower backend list was designed and measured, then rejected. The figures below are the 2026-09-14 snapshot that settled it, not live counts. Of the 26 files then under `worker/src/`, exactly TWO decided nothing a caller can reach: `utils/errors.ts` (an envelope builder — the status and the error `code` are the caller's) and `middleware/kvOpCounting.ts` (a pure-forwarding Proxy plus one log line). Every other file makes an access decision, validates a boundary, spells a KV key, fixes a TTL, orders middleware, or carries a security-UX invariant. `utils/openapi.ts` reads like a third one and is not: its `defaultHook` is the 400 that stops an invalid body from reaching a handler, and condition 4 is path-only, so half a file cannot be released. Those two files are 187 of 8,078 lines (2.3% of the tree), and across ALL 84 commits in this repo's history that touched `worker/src/`, ZERO were confined to them. The decisive measurement is the opposite one: 29 of those 84 commits changed ≤ 40 lines — fix mode's own size budget — and every one of them landed in routes, rate limiting, validation, CORS or the auth path (scoping the borrow list to records the caller is a party to; switching a join fingerprint to a constant-time compare; making refresh failures answer a generic 401 so they stop being a membership oracle). In THIS repo a small backend change is overwhelmingly a SECURITY change, so a narrower list would add a per-file judgment call to every backend run and buy back no measured run. Backend having no practical fix mode is the accepted outcome, not an oversight. Re-open only with a counter-measurement — a run of real backend changes confined to non-deciding files — never from an intuition that the exclusion feels too broad.

### Decision timing: predict at entry, measure after every coder return

- **Predict** (before Phase 0): check the four conditions against the ESTIMATED change. Count every new file whole, and for a file pinned at its `MAX_LINES_LEGACY_CEILINGS` entry (`wc -l` equals the number) count the lines an extraction will move — there, every added line needs an offsetting deletion. That prediction selects the mode for the run; state it in the run's first user-visible message as one line: the mode plus each condition's verdict.
- **Measure — after EVERY coder return, not only the first.** Stage the coder's `Files Modified` list first (Phase 3 step 2), and confirm `git branch --show-current` still equals the branch recorded in Phase 0 step 10 — a mismatch means another session took over the checkout: stop and report before anything else. Then re-run the condition-3 measurement verbatim — same `merge-base` base, same exclusions, both `--numstat` columns summed — and re-check all four conditions against the ACTUAL cumulative diff. Also run `git status --porcelain`: any untracked (`??`) entry under `extension/`, `pwa/`, `worker/`, or `shared/` escalates the run to the full cycle, because an un-added new file is invisible to `git diff` and would otherwise count as 0 lines. The three test trees are the exception — an untracked entry under `extension/tests/`, `pwa/tests/`, or `worker/tests/` NEVER escalates and only earns a `git add` reminder, since test code sits outside the 40-line budget and fix mode's own regression test is normally a brand-new file. This explicitly includes every Fix-Cycle CRITICAL-fix round: a fix round can push the total past 40 lines or drag in a condition-4 path, and that round's measurement escalates the run exactly like the first one would. The measurement, not the prediction, is authoritative.
- **Escalate in place.** When any measurement shows the diff over 40 lines, or any other condition violated, switch to the full cycle FROM THE CURRENT POSITION: phases already completed are NOT re-run; continue through the remaining full-cycle phases (verify-before-test gate, tester, full review, Phase 5 / Phase 6 as applicable). Late escalation (after the tester or the CRITICAL-only review has already run) does NOT re-instate the verify-before-test gate — its purpose has passed. It MUST re-dispatch the `reviewer` for a FULL review of the cumulative diff (SUGGESTIONs tabled per 4.1/4.3); the CRITICAL-only pass does not count as the full-cycle review. State to the user that the mode escalated, which condition tripped, and the measured number.
- Escalation is one-way: a full-cycle run never downgrades to fix mode mid-run.

### Fix-mode flow

Phase 0 branch preflight → `coder` → stage + scope verify (`pnpm typecheck && pnpm lint && pnpm test`; backend prefixes `cd worker &&`) → Phase 4 base re-check → `tester` per the fix-mode tester rule, in parallel with the `reviewer`, dispatched normally (production is frozen once staged — Phase 3 step 4's parallel conditions apply) → re-run the scope verify so the new regression test is included → E2E impact check (frontend scope) → focused review of the new test file → Phase 8 (completion report + commit gate, with the Phase 7 retro question in that same batch) → Phase 9 (post-merge cleanup gate, once the PR is merged).

- **Phase 1 collapses to a single opening presentation.** Restate the pinned root cause (`file:line`), the acceptance check and the Predict verdict in the run's opening message, before the first dispatch, then continue — there is NO separate confirmation stop. The TodoWrite checklist is still maintained (with the fix-mode steps). Phase 1's **bug fast-path** does not apply here: it defers confirmation to the verify-before-test gate, and fix mode has no such gate — the root-cause restatement above replaces it.
- **Phase 2 is structurally N/A** — eligibility condition 2 forbids API-contract and KV-schema changes, so there is no contract to define.
- **Tester dispatch, spelled out.** Dispatch `tester` with `scope`, `target`, `scope_intent: quick`, and `change_summary` (+ the actual diff). The prompt MUST carry this sentence verbatim: "EXACTLY ONE regression test — the single check that is red before the fix and green after it; no coverage expansion." Both halves are load-bearing: `.claude/agents/tester.md` defaults `scope_intent` to `full`, so omitting either the `quick` intent or that sentence gets the coverage expansion fix mode exists to avoid.
- **The E2E impact check is KEPT (frontend scope).** Only the verify-before-test GATE is skipped in fix mode — this check is not. Run the existing **Phase 3 E2E Impact Check** procedure unchanged, in the position it holds there (after the scope verify that includes the new regression test, i.e. once unit/component tests pass): identify whether any changed production file is imported — directly or transitively — by `extension/tests/e2e/` or `pwa/tests/e2e/`; run `npx tsc --noEmit --project tests/e2e/tsconfig.json` in the affected package; on failure dispatch `coder` to fix the breakage (imports, helpers).
- **The `reviewer` is dispatched NORMALLY; only the ORCHESTRATOR is CRITICAL-only.** Pass the usual `scope` / `target` / `business_logic` and do not ask the reviewer to narrow its output — its return format is unchanged (Critical / Suggestions / Observations per `.claude/agents/reviewer.md`). "CRITICAL findings only" describes what YOU do with that return: SUGGESTION findings are never tabled, never presented for a decision, never fixed in-run. They have exactly ONE outlet — every SUGGESTION that grades **P0 or P1** against `.claude/rules/change-triage.md` is recorded through that file's "Disposition of out-of-scope P0/P1" path (`gh issue create`, tier label, `file:line`, consequence of leaving it unfixed), **whether or not it belongs to the current task**. In-scope is deliberately routed the same way: fix mode declines to widen the run, so without that outlet an in-scope P0/P1 would be silently dropped. P2 items and non-goals are dropped silently, as always. Never a worktree, never a follow-up task chip, never scope expansion.
- **CRITICAL findings are auto-fixed** exactly as in §4.2 — fix → re-verify → re-review only the changed files — with no user gate.
- **Skipped in fix mode:** the Phase 3 verify-before-test gate, Phase 5 (cross-scope validation — unreachable, fix mode is single-scope), and Phase 6 (security scan). Phase 7 (retro) is NOT skipped — its question rides in the commit gate, which fix mode keeps. Be honest about what skipping Phase 6 costs: condition 4 excludes every path that would trigger a security-auditor-specific scope (`api`, `crypto`, `secrets`, `deps`, `invariants` per Phase 6's scope map), so what fix mode forgoes is the generic `code` / `extension` sweep over a ≤ 40-line, CRITICAL-reviewed diff — a documented residual, accepted deliberately. **One combination forgoes slightly more.** A diff touching BOTH `extension/src/` and `pwa/src/` passes condition 1 (both are `frontend`) yet spans two AREAS, so the full cycle would map it to `full` rather than to `code` + `extension`. Of the extra dimensions `full` brings, condition 4's paths already leave `crypto`, `api`, `invariants` and `deps` with nothing to scan, so the genuine additional loss is the `secrets` (hardcoded-credential) and `publish` (pre-publish readiness) sweep over that diff. Accepted on the same terms; it does NOT disqualify the change from fix mode.
- **Not skipped:** Phase 7 and Phase 8. **The Phase 8 commit gate is fix mode's single user gate** — the commit is ALWAYS an explicit user question, in either mode, and the Phase 7 retro question rides in that same batch. The Phase 8 completion report MUST state that the run used fix mode, list what fix mode skipped (the verify-before-test gate, Phase 5, Phase 6), and state how many P0/P1 SUGGESTION issues were opened via the disposition path — zero is stated as zero, never left implicit. Omitting that disclosure is a defect, not a tidier report.

### Fix-mode tester rule

- A **behavioral bug fix** gets EXACTLY ONE regression test — the single check that is red before the fix and green after it. No coverage expansion beyond it: no extra cases, no neighbouring-behaviour tests, no reshaping of existing test files.
- A **pure copy / typo fix** (user-facing string, comment) needs no new test; run the existing suite only. If an existing assertion pins the changed string, update that assertion instead of adding a test.

## Phase 0: Branch Preflight (before any code)

Guarantee the change lands on its own clean branch off `origin/main`, so another task's commits can never contaminate this PR's diff. Do this once, up front — silently if already clean, otherwise fix it before Phase 1.

1. `git fetch origin`.
2. **Base:** unless the user named a base branch or asked to continue an existing branch, base the task on `origin/main`.
3. **Isolation check (ahead):** run `git log --oneline origin/main..HEAD`. If it is non-empty — the current worktree/branch already carries unrelated commits — do NOT commit on top. Cut a fresh branch from `origin/main`: `git checkout -b <type>/<slug> origin/main` (or create a new worktree from `origin/main`).
4. **Freshness check (behind):** run `git log --oneline HEAD..origin/main`. Non-empty means the base is stale — fast-forward/rebase onto `origin/main` BEFORE Phase 1, and confirm with `git rev-parse` that the branch point equals the freshly fetched tip (a stale local ref silently pins an old base). When a worktree shows unexpected changes, diff against its own base (`git diff HEAD`) and read `git log HEAD..origin/main` before concluding contamination — upstream drift is not another task's dirt.
5. **Premise check:** whatever the task cites about repo state — a branch that "already has" the work, a `file:line` anchor, a helper that "exists" — is a lead, not a fact. Verify with `git branch -a` / `git cat-file -e` / grep before it shapes the plan or any agent prompt. If the cited work exists only as uncommitted state in another worktree, stop and present options (wait for its commit / import the diff with provenance noted). A worktree that opens with uncommitted changes resembling this task: `git diff` against the spec first — the work may already be done.
6. **Name it meaningfully:** `<type>/<short-kebab-slug>` — conventional type (`feat`/`fix`/`refactor`/`docs`/`test`/`chore`) + a concise English task slug (e.g. `fix/save-before-sync`). Never keep an opaque auto-generated worktree name (`claude/angry-moore-3651ca`) as the PR branch — rename first.
7. Re-confirm `git log --oneline origin/main..HEAD` is empty before starting Phase 1. See `.claude/rules/global.md` → "Branch & Worktree Hygiene".
8. **Worktree tasks:** when the task runs in a dedicated worktree, start EVERY agent prompt by restating the worktree's absolute path, forbidding any write to the main checkout, and requiring the agent to confirm the path prefix before every Read/Edit/Write — stating the boundary alone has proven insufficient.
9. **Worktrees are only for tasks the user explicitly starts.** A defect or improvement surfaced mid-run never gets a worktree or a follow-up task chip of its own — see `.claude/rules/change-triage.md` → "Disposition of out-of-scope P0/P1".
10. **Record the starting point:** `git branch --show-current` and `git rev-parse HEAD`. The branch is re-checked after every coder return and before the commit (another session can take over a shared checkout); the HEAD is condition 3's base when the run continues an existing branch. If you are in the main checkout and it is not on `main` (or the user-named base), do not switch it away — another session may own that branch; run the task in its own worktree.
11. **Dependencies:** a fresh worktree has no `node_modules` — run `pnpm install --frozen-lockfile` before any baseline measurement or verify.

## Phase 1: Requirements Analysis (collaborative — iterate until confirmed)

1. Read the requirement carefully.
2. **Verify cited specifics.** Externally supplied lists (audit findings, handler or call-site inventories) and quoted concrete examples (URLs, payloads, error strings) are leads, not facts: re-enumerate lists from source — grep BOTH `extension/` and `pwa/` so mirror surfaces are not missed — and execute examples before any of it enters an agent prompt or a doc. What stays unverified is marked unverified, never stated as fact. **Your OWN premises count too**: deployed-version behaviour (verify with `git log -S` / `git show`, never from a client-side type), third-party page behaviour (DOM, fiber props, paging — check the real page), the shape of real stored records (get one real sample or an anonymised count), and every number (compute it — byte counts, sizes, estimates). A premise you cannot verify is labelled 「未驗證」 in the coder prompt, option text and PR body, together with the conservative branch to take if it is false.
3. **Bug / incident intake** (bug-type requests only — skip for features):
   - **Surface matrix first.** Before reading any code, establish WHICH surface is broken: Extension-Chrome / Extension-Firefox / PWA × device × symptom. Investigate only the broken surface — don't burn context reading an unaffected one.
   - **Delegate broad scans.** Multi-file investigation sweeps go to an `Explore` agent that returns conclusions; you self-read only the 3–5 key files that anchor the diagnosis.
   - **Masked fields are unknowns.** If you asked the user to redact a sensitive field (token, id), record it as "existence unknown" — never treat its absence from pasted output as evidence.
   - **Fast-path** (single scope + root cause already pinned with `file:line` evidence + no API/schema change): you MAY fold the requirements analysis into the Phase 3 verify-before-test gate presentation instead of a separate confirmation stop, and write the pinned root cause into the coder prompt.
4. Read `docs/project-plan.md` and `docs/architecture.md` for context (skip if absent).
5. Break the requirement into work-items, each tagged **frontend** (Extension UI, Content Script, crypto, PWA) or **backend** (Worker API, KV schema, middleware), plus **shared concerns** (sync code format, API contract).
6. **Proactively identify gaps and risks** — present these to the user:
   - **Assumptions** you are making.
   - **Missing / ambiguous** aspects: edge cases, error/empty/loading states, UX flows, concurrency, data migration, KV key collisions, TTL strategy.
   - **Security concerns** (frontend: XSS, `dangerouslySetInnerHTML`, secrets in client, `chrome.storage` exposure; backend: auth bypass, plaintext exposure, KV key injection, rate-limit evasion).
   - **Performance concerns** (frontend: needless re-renders, bundle size; backend: N+1 KV reads, payload size, cold start).
   - **Lifecycle & resource cost** — for ANY feature with FE polling/auto-refresh, BE scheduled jobs, or background sync: back-of-envelope cost (1 user × 24h × N devices) vs Cloudflare Workers' ~100k req/day free tier. **If realistic worst case > 1,000 req/user/day or polling is unbounded → mandate on-demand or visibility-gated design and flag it now, not at review.** See `.claude/rules/global.md` → "Lifecycle & Resource Cost".
   - **Concurrency & multiple writers** — for any state the design adds, guards or merges (a membership pointer, token, version stamp, cached list): grep every writer of it AND of the data it protects, every concurrent revoke / overwrite path, the same account's other devices / sessions / tabs, and the events that can land while an async wait is pending. Each interleaving's expected outcome goes into the coder prompt.
   - **Merge rules** (local × server state): derive them from what the user saw when they acted, spell out every cell in the analysis AND the coder prompt, and default any cell you are unsure of to not-shared.
   - **Open questions** needing the user's decision.

   Every listed risk gets a destination — the design, a coder-prompt acceptance condition, or an explicit accept — and the list travels verbatim into the Phase 4 reviewer prompt as items to check specifically.

7. **Mockup gate (optional).** If the feature introduces a new screen / dialog / overlay or significantly reshapes one, offer to dispatch the `designer` agent for a Pencil mockup before coding (user decides; skip for string/styling/internal changes). On yes, dispatch `designer` with `request` + `context`, relay its screenshot + annotations, iterate to approval, then continue.
8. Present the full analysis. **Wait for user confirmation before proceeding.** (Bug fast-path per step 3 may defer this to the verify-before-test gate.)

## Phase 2: API Contract (full-stack features only)

If the feature spans frontend and backend:

1. Define the contract: endpoints, HTTP methods, request/response shapes, error codes.
2. Document it in the work-item breakdown — both scopes code against it in parallel.

## Phase 3: Development

**Pure-refactor fast path.** When the task is a pure move/equivalence refactor whose acceptance is "existing suite unchanged and green", declare at Phase 1 that the verify-before-test gate and the tester dispatch are N/A: dispatch a `tester` only when tests are to be authored or modified (if a tester prompt would mostly prohibit changes, don't send it). The oracle is the frozen suite — run a baseline test count before coding and compare after (it must not drop) — plus byte-identity verification of every moved block (`git show HEAD:<file>` diffed against the new location, mechanically, never by eye). Hold ONE consolidated stop after the suite runs.

For each scope in play (frontend, backend — parallelize when file-disjoint):

1. Dispatch **`coder`** with `scope`, `requirements`, `files`.
2. After the coder returns, run the scope's verify: frontend `pnpm typecheck && pnpm lint`; backend `cd worker && pnpm typecheck && pnpm lint`. (NOT the full test suite yet — new behavior isn't test-covered.) Then read the diff and stage the accepted output — the coder's `Files Modified` list, deletions included (`git add -A -- <paths>`; agents never stage) — so the index snapshots the delivery; any destructive experiment on tracked files (tripwire, mutation check) requires staged state or a scratchpad copy first — never mutate-then-checkout over unstaged agent work.
3. **Verify-before-test gate [STOP — manual verification].** Before any test is written, present:
   - a concise summary of what the coder changed (files + behavior + affected states),
   - how the user can verify it (frontend: what to click/observe; backend: a curl example or KV state to inspect),
   - instructions that run as written: name the execution context (shell, directory, DevTools context), state that the change exists only locally — with the local URL / launch command — and, in a worktree, its absolute path plus a self-check line (`git branch --show-current` prints `<branch>`), since the main checkout and other worktrees serve different code. Check that the gitignored local config (`.env`, `worker/.dev.vars`) exists in this worktree; when it is missing, say what changes (read it from the config — e.g. the API base URL falling back to the production server) and the two fixes (copy it from the main checkout, or `pnpm dev:remote`). URLs and ports come from the config files, never from memory. For backend scope, default to the orchestrator RUNNING the verification (curl / KV inspection) and presenting observed results; copy-paste commands are the fallback,
   - **any rate limit / quota the tested flow touches** (limit, window, retry interval) — so throttling (e.g. a 429) isn't misread as a functional defect and repeated manual retries don't burn the quota,

   then ask the user to confirm it's correct OR point out fixes. Print the whole presentation and the Stop Block first; the question may then go through AskUserQuestion (correct / needs fixes, plus 「跳過手動驗證，交給自動測試」 when every behaviour delta is machine-assertable — no layout or visual change), and its text never points at content not printed above. **Rationale:** writing tests against unconfirmed behavior forces repeated rewrites.
   - Fixes needed → dispatch `coder` to fix, re-run typecheck/lint, re-present this gate. **Batch feedback:** when one gate round returns several small UI remarks, fold them into ONE coder dispatch (file-disjoint) and one tester pass afterward — never one full round-trip per remark.
   - Confirmed correct → proceed to step 4.

4. Dispatch **`tester`** with `scope`, `target`, `change_summary` (+ the actual diff). Production code is frozen once the gate confirms, so the tester, the Phase 4 `reviewer` and — by default — the first Phase 6 scan are dispatched in parallel, on three conditions: everything that affects their result (production, config, ceiling lists) is staged before dispatch, and anything still unstaged is named in the prompts; the reviewer prompt says to read production and config from the index (`git show :<path>`), not the working tree; and the tester's test files get a focused review once it returns (hold any earlier finding against test code until then). Fix-Cycle changes get a focused re-scan of the changed files.
5. Run full verify: frontend `pnpm typecheck && pnpm lint && pnpm test`; backend `cd worker && pnpm typecheck && pnpm lint && pnpm test`. Run the full suite ONCE, here — do not re-run it when an agent just reported it green, and never let it overlap an agent's own run (two concurrent full suites cause CPU-contention flakes). Repeated stress runs (flake reproduction, N-times-green acceptance) are the orchestrator's job after the agent returns.

**Gate** — all must pass before Phase 4 acts on findings: coder done + user-confirmed; tester done; typecheck/lint/test green; E2E impact check (below) passes. (The reviewer dispatch itself may start early per step 4 — the gate then blocks Fix-Cycle actions, not the dispatch.)

**E2E Impact Check** (after unit/component tests pass, frontend scope):

1. Identify whether any changed production files are imported (directly/transitively) by E2E tests (`extension/tests/e2e/`, `pwa/tests/e2e/`).
2. Run E2E typecheck: `npx tsc --noEmit --project tests/e2e/tsconfig.json` in the affected package.
3. On failure, dispatch `coder` to fix the breakage (imports, helpers). This catches compile-time breaks early; it does NOT require running the full E2E suite locally.

## Phase 4: Review + Fix Cycle

Dispatch **`reviewer`** (`scope`, `target` = changed files, `business_logic`, plus the Phase 1 risk list verbatim as items to check specifically) per scope. Then repeat **Review → Fix → Re-review** until clean. Maintain a running **Fix Cycle Log** of every CRITICAL auto-fixed and every SUGGESTION accepted/skipped — present it each round and on exit.

**Base re-check before EVERY reviewer dispatch** (first round and each Fix-Cycle round, fix mode included; mark `base re-check ✅` in the Stop Block's progress list): `git fetch origin` + `git log HEAD..origin/main`. If upstream moved, update with the recipe below first — a stale base turns upstream commits into phantom findings. Reviewer and auditor always get the merge-base SHA (`git merge-base origin/main HEAD`) as `base_ref`, never a branch name or the moving tip.

**Updating uncommitted work onto a moved main** — never `git stash` (the stash stack is shared across worktrees):

1. No overlap with upstream's changed files → `git merge --ff-only origin/main`.
2. Overlap only in `CHANGELOG.md` → save `git diff --cached -- CHANGELOG.md` to a scratchpad patch, `git restore --staged --worktree CHANGELOG.md`, fast-forward, then `git apply --3way` the patch (or re-insert the same bullet text at the end of its sub-section with Edit). Moving existing copy is mechanical — the orchestrator does it, no coder dispatch.
3. Overlap in code → `git commit -m "wip: <slug>"`, then `git rebase --reapply-cherry-picks --empty=keep origin/main` (a plain rebase DROPS a WIP whose changes are already on main, so `HEAD~1` would then be a real commit), confirm `git log -1 --format=%s` prints the `wip:` subject, and only then `git reset --soft HEAD~1` — never `--soft origin/main`, which would also flatten a continued branch's earlier commits; production conflicts go to the `coder`, test conflicts (and adapting upstream's new tests) to the `tester`.

Then re-run verify workspace-wide — `pnpm lint` and `pnpm typecheck` from the root, not only this run's scope: a moved main can break a content-dependent ratchet (max-lines ceilings) in a file this run never touched. Red on main itself → `.claude/rules/change-triage.md` disposition, never a wider run.

**In-round adjudication:** every coder/tester return's Open Questions and in-scope side observations get an explicit disposition THIS round (fix now / accept as residual / route per `.claude/rules/change-triage.md`), recorded in the Fix Cycle Log — never left for a later phase to rediscover. Orchestrator-discovered defects enter the log with the same standing as reviewer findings. Before turning a reviewer coverage/absence claim into a prescription, verify it against the target file yourself.

**Fix-round handoffs:**

- **Behavior handoff**: when a fix renames a production export OR changes behavior that existing tests pin, first grep the affected code path / error code / field across the test trees, then the coder prompt lists the expected-red tests and the new expectation; the follow-up tester prompt carries that list verbatim — one coder→tester round, no discovery pass.
- **Prescription exception to re-review**: when a fix lands the reviewer's own suggested change verbatim and touches ≤ 5 lines, the orchestrator MAY verify the diff itself instead of dispatching a re-review — record the self-check in the Fix Cycle Log. Any deviation from the prescription, or a larger diff, gets a normal focused re-review.

Findings are **always tables**, never free-form bullets (write "None." in a single row when empty). **All tables ≤ 4 columns** for narrow terminals.

### 4.1 Present Findings

**CRITICAL** (pass through reviewer verbatim, no TL column — auto-fixed in 4.2):

| #   | Location    | Issue / Impact                  | Suggested Fix |
| --- | ----------- | ------------------------------- | ------------- |
| C1  | `file:line` | <issue><br>**Impact**: <impact> | ...           |

**SUGGESTION triage gate (BEFORE the table).** Grade every SUGGESTION finding against `.claude/rules/change-triage.md` first. Only **P0** and **P1** findings enter the table; **P2 items and non-goals are dropped silently** — not tabled, not mentioned in passing, not turned into follow-ups. (This is SKILL.md §1's "Triage before proposing" applied to the reviewer's output.) A finding that survives the gate must carry its `file:line`, the consequence of leaving it unfixed, and whether a failing check can be written. If nothing survives, the table is a single "None." row. A surviving P0/P1 that does NOT belong to the current task is not tabled either — it goes to `.claude/rules/change-triage.md` → "Disposition of out-of-scope P0/P1".

**SUGGESTION** (pass the surviving findings through verbatim; add the rightmost **TL 建議 / 原因** column — colored circle + Chinese label + one-line reason):

| #   | Location & Issue     | Suggested Fix | TL 建議 / 原因              |
| --- | -------------------- | ------------- | --------------------------- |
| S1  | `file:42` — <issue>  | <fix>         | 🟢 **建議修**<br><reason>   |
| S2  | `file:120` — <issue> | <fix>         | 🔴 **建議跳過**<br><reason> |

**TL Recommendation legend** (use exactly these two — no variants):

| Label           | Use when                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------- |
| 🟢 **建議修**   | Low risk, clear benefit — this P0/P1 finding is worth fixing in this run                       |
| 🔴 **建議跳過** | YAGNI / out-of-scope for this run / better deferred to a `gh` issue (per the disposition rule) |

The TL Recommendation is **your professional judgment** — the "原因" line lets the user confidently override. Be honest: many SUGGESTIONs are safe to skip. While classifying, flag any **special technical decision** (a choice between equally-reasonable options, e.g. strict vs lenient validation) for the 4.3 Decision Prompt.

### 4.2 Handle CRITICAL (do NOT ask the user)

1. Merge + dedupe all CRITICAL findings.
2. Assign fixes immediately: production-code issues → `coder`; test-code issues → `tester` (pass the scope).
3. Run the scope's full verify (typecheck/lint/test).
4. Re-review **only the files changed by fixes** via `reviewer`.
5. Append to the Fix Cycle Log and present the round's Auto-Fix Log (≤ 4 cols):

   ```
   ## Round N — 自動修復的 CRITICAL
   | # | Finding @ Location | Fixed by | Verification |
   |---|---|---|---|
   | C1 | <issue> @ `file:42` | coder (frontend) | ✅ typecheck/lint/test |
   ```

6. Return to 4.1 with the new results.

### 4.3 Handle SUGGESTION (requires user approval)

When no CRITICAL remain and SUGGESTIONs exist:

1. Present the classified table + a **TL 建議 summary + Decision Prompt**:
   ```
   ## TL 建議
   🟢 建議修：S1, S3（<一句話理由>）
   🔴 建議跳過：S2, S4（YAGNI／改開 gh issue）

   ## 請您決策
   [若有特殊技術抉擇，列為前面的問題]
   1. <技術抉擇問題…>
   2. 採用 TL 建議（修 S1, S3）？／自選清單？／全部跳過直接出報告？
   ```
2. **Wait for the user.** End with the Stop Block.
3. On approval: dispatch `coder`/`tester` for the selected rows only → verify → re-review only changed files → back to 4.1.
4. On skip-all: proceed to Phase 5.

### 4.4 Exit + Summary

Exit when **no CRITICAL remain AND no user-requested SUGGESTION fixes remain**. Present the consolidated **Fix Cycle 總結** (all tables ≤ 4 cols): 已自動修復的 CRITICAL / 已採用的 SUGGESTION / 已跳過的 SUGGESTION. End with a one-paragraph prose summary (e.g. "本次共經 2 輪 Fix Cycle，自動修復 2 項 CRITICAL，採納 2 項使用者同意的 SUGGESTION，其餘依建議跳過。FE/BE typecheck/lint/test 全綠。").

## Phase 5: Cross-Scope Validation (full-stack only)

Only when both frontend and backend changed:

1. Verify API contracts match (request/response shapes, error codes) between FE and BE.
2. `pnpm test` (extension) → green; `cd worker && pnpm test` → green.
3. `pnpm typecheck` both sides → clean.
4. E2E typecheck on affected packages → clean.
5. Any cross-scope issue → classify like 4.1: CRITICAL → fix via the owning scope's `coder`/`tester` (re-enter Fix Cycle); SUGGESTION → TL 建議 + Decision Prompt, wait for user. If none, skip.

## Phase 6: Security Scan

Run **once** for the whole feature, **before the commit gate**, not per sub-task — by default dispatched alongside the first-round review (Phase 3 step 4), with a focused re-scan of whatever the Fix Cycle and cross-scope validation change afterwards.

1. Pick scope(s) from all changed files since the feature began:
   - `extension/src/crypto/`, `pwa/src/crypto/`, `shared/src/crypto/` → `crypto`; `worker/src/` → `api`; `extension/src/` → `code` + `extension`; `pwa/src/` → `code`; `shared/src/` → `code`; `.env*`/`wrangler.toml`/CI/CD → `secrets`; deps changed → `deps`. Rows are ADDITIVE — take the union of every row the diff matches.
   - **`multiple areas` → `full`, defined mechanically.** There are five **areas**, and a changed file belongs to exactly ONE because `config` is tested first: `config` (`.env*`, `wrangler.toml`, `.github/workflows/**`, any `package.json` at any level, `pnpm-lock.yaml`, `site/`), then `extension/`, `pwa/`, `worker/`, `shared/`. Testing `config` first is what makes `extension/package.json` count as `config` rather than as `extension`. A file matching none of the five (`docs/`, `.claude/`, top-level markdown) belongs to no area and is not counted; neither does anything under the three test trees (`extension/tests/`, `pwa/tests/`, `worker/tests/`) — the same exclusion as fix-mode condition 3. Count the DISTINCT areas the changed files fall into; **2 or more → `full`**, overriding the union above. Never read it as "multiple rows": an Extension-only crypto change matches TWO rows of the scope map (yielding three scopes) and is still ONE area, and `crypto` + `code` + `extension` is already the right scope set for it. Two areas is the trigger because that is the first point at which one change can break a contract — between two runtimes, or between a runtime and the configuration that deploys it (`worker/src/` plus `wrangler.toml`, which `.claude/rules/backend.md` requires to change together for any per-minute limit, is two areas and lands on `full` by design). **Expect `shared/` to land on `full` almost every time.** `shared/src/` exists to be consumed by two or three runtimes, so the typical shape of a change there is `shared/src/` plus at least one caller in `extension/` or `pwa/` — two areas → `full`. That is intended, not an accident of the counting: one edit to shared code changes behaviour on every runtime that imports it, which is exactly the blast radius the 8-dimension scan is for. A `shared/`-only change (no caller touched) stays at the union of its rows.
   - **Business-logic / invariant surfaces → also add `invariants`** (Dimension 8): any change under `worker/src/routes/` (family / bookshelf / member / user / auth) or `worker/src/middleware/auth`, or any FE change to the sharing / save-before-sync flow (`PersonalShelf`, `usePersonalBooks`, `usePersonalShelf*` hooks, `api/client` sharing calls), or to the PWA login / token hand-off path (`useLanding*`, `useQrJoin`). These carry the security-UX invariants (Inv-1..6), which the plain `api` / `code` scopes do **not** cover.
2. Dispatch **`security-auditor`** with that scope (set) plus `mode: changed` and `base_ref` = the merge-base SHA (`git merge-base origin/main HEAD`, as in Phase 4), so the scan focuses on the feature's diff + its blast radius instead of re-scanning the whole repo. (Use `mode: repo` only for a deliberate periodic full audit, never for a routine post-feature scan.)
3. Present findings.
4. **CRITICAL** → flag with remediation; recommend fixing before merge (user acknowledgement required). **WARNING** → report, non-blocking.

This phase auto-starts (no confirmation to begin), but CRITICAL findings require user acknowledgement.

## Phase 7: Retro (offered once per run, at the commit gate)

The run retrospective is **OFFERED exactly once per run and never auto-run**: the question 「要不要為這次 run 寫 retro 報告？」 travels in the SAME AskUserQuestion batch as the Phase 8 commit question — one extra question inside a gate that already exists in every mode, fix mode included, so it adds no stop. It is not suggested anywhere else and not re-asked after a "no". The user may also ask for it mid-run; that counts as the offer and the commit-gate question is then dropped.

When the answer is yes: read `references/retro.md` and follow it in **this session** (it needs the full conversation history — an isolated subagent cannot write it). The report lands in `.claude/reports/<MMDD_HHMM>.md` **before the commit runs**, so it rides along in the feature's commit — no follow-up `chore(retro)` commit needed. The retro writes conclusions only; applying its proposals is `/distill`'s job (periodic, user-invoked), never done in-run.

**Why offered, not on request** (reinstated 2026-09-16; PR #147 had made it request-only to curb self-multiplying work): the report is the only git-tracked record of whether a run exposed a process gap — memory files stay on one machine and one user, so a request-only step is simply forgotten. The #147 concern is contained by `/distill` batching the proposals, not by never asking.

## Phase 8: Complete

1. Re-present the Fix Cycle 總結 (+ any cross-scope additions + the security-scan verdict). In fix mode, render the security-scan line as 「不適用（fix mode — no scan was run）」 — never drop the line, never state a verdict no scan produced.
2. List changed files (all scopes) + final verification status.
3. End with a single **prose headline paragraph** consolidating the outcome.
4. **Base re-check:** as in Phase 4 — long runs go stale while parallel sessions merge. If main moved, update with that recipe and its workspace-wide verify before committing; surface the update in the report. When the diff adjusts a content-dependent tripwire (max-lines ceilings, a snapshot), the report tells the user to update the PR to the latest main and re-run CI before merging.
5. **Diff hygiene:** confirm `git branch --show-current` still equals the Phase 0 branch, then `git status --short` over the whole tree — the set to stage must equal this feature's expected file list (a retro report already written mid-run under `.claude/reports/` IS on that list). Stray entries (formatter churn, EOL rewrites, another task's leftovers) are inspected and restored, never swept into the commit.
6. **CHANGELOG bullet — presence, then placement:** first decide whether this run changed anything a reader can observe (`.claude/rules/user-facing-copy.md` Rule 2 — behaviour counts, not just strings: a Worker-only permission fix is observable). If YES, `git diff $(git merge-base origin/main HEAD) -- ':(top)CHANGELOG.md'` MUST be non-empty, and its additions must lie ONLY inside the `## 未釋出` section (the first `## ` heading in the file, above the most recent `## vX.Y.Z` entry); an empty diff here means the coder skipped the bullet — dispatch it back for the bullet before committing. Measure against the run's merge-base (same base as the fix-mode size check, substituting the user-named base branch if any), never with a bare `git diff`: that shows unstaged edits only, so a bullet already staged — or already committed by an earlier Fix-Cycle round or on a continued branch — would read as missing and be written twice. A bullet under a `## vX.Y.Z` heading is a defect — that version is already tagged and released — move it before committing (that rule's "Where a change is recorded"). If NO, `CHANGELOG.md` must be untouched. **Then depth and de-AI:** the bullet must satisfy that rule's Rule 8 (main bullet 1–2 sentences, at most one sub-bullet, no deployment steps, no attack narration) and the coder's return must carry a `Copy Pass` block with the `speak-human-tw` 事後摘要 (Rule 9). A bullet that fails Rule 8, or a return with the block missing, goes back to the coder for the copy alone before the commit gate — do not rewrite it in the orchestrator, do not commit around it.
7. `git add` explicit paths only (including the retro report, if one was already written mid-run).
8. Ask the user about committing, and — in the same AskUserQuestion batch — whether to write the run retro (Phase 7), unless a retro was already requested mid-run. (Commit is ALWAYS an explicit user question — never auto-run.) If retro = yes: write the report first, `git add` it, then commit the way the user chose.

## Phase 9: Post-merge cleanup gate (inventory, then ASK — never act unasked)

**Trigger:** the session learns that the run's PR has MERGED — a `<ci-monitor-event>` from the desktop app, `mcp__ccd_pr__get_status` reporting `MERGED`, or the user saying so. Not before the merge, and not on a PR closed without merging (ask the user what they want with the branch instead). **Merging itself is the user's action, done by hand on GitHub**: this phase never runs `gh pr merge`, never enables auto-merge, and never suggests doing either — it only reacts to a merge that has already happened. The phase exists because post-merge leftovers (stale local branches, orphan worktrees) accumulate silently when cleanup depends on someone remembering; it lives here, not in a per-machine memory, so every clone behaves the same.

**Hard rule: nothing is deleted, removed or archived without the user's answer to step 2 — in every permission mode, auto mode included.** A stale branch costs nothing; a lost one is unrecoverable from a user's point of view. Exceptions are not granted by "it is obviously merged".

1. **Inventory, read-only, and present it as a table** before asking: `git fetch origin --prune` (a remote branch GitHub auto-deleted on merge shows as upstream `gone`), `git worktree list`, `git branch -vv`, `git stash list`. For every local branch of this run — and any other branch whose upstream is `gone` — establish its merge state:
   - `git merge-base --is-ancestor <tip> origin/main` true → plain stale pointer, `git branch -d` is safe.
   - Otherwise it is usually a **squash merge**, where `-d` refuses with "not fully merged" although the content IS on main. Verify by content, not by ancestry: the files the branch changed (`git diff --name-only $(git merge-base <tip> origin/main) <tip>`) must be byte-identical on `origin/main` (`git diff --stat <tip> origin/main -- <those files>` empty — a CHANGELOG that main has since extended needs its branch-added lines checked individually), AND `gh pr list --state merged --head <branch>` must show the merged PR. Only then is `-D` allowed. Any mismatch → that branch is excluded from every option below and named in the report.
   - A worktree qualifies for removal only when it is clean (`git -C <path> status --short` empty), its HEAD is contained in or content-verified against `origin/main`, and no active session owns it (`mcp__ccd_session_mgmt__list_sessions` — an archived session's folder that `mcp__ccd_host__discard_kept_worktree` reports as "no kept worktree" is an orphan the app no longer tracks).
   - **Ignored files are invisible to `git status` and `git worktree remove` deletes them without `--force`** — git cannot restore them afterwards. Before any worktree enters the table, list its ignored files with `git -C <path> ls-files --others --ignored --exclude-standard --directory` (paths only, never contents) and show the paths in the inventory. `--directory` collapses an ignored directory to one line (`worker/.wrangler/`, never `state/` vs `tmp/`), so for any collapsed entry whose contents are split between the two lists below, run `ls -A <that dir>` and classify its children one by one. Disposable by default: `node_modules/`, `dist/`, `.wrangler/tmp/`, `.husky/_/`, other build or cache output. NOT disposable: `.env*`, `.dev.vars`, `wrangler.local.toml`, `.claude/settings.json`, `.claude/settings.local.json`, `.skill-archive/`, `.verify-selectors-profile/` (a persistent Chrome profile holding the Readmoo login), `docs/resource/` (real Readmoo page dumps with personal data), `worker/.wrangler/state/` (the local `wrangler dev` KV data — `pnpm clean:kv` deletes exactly this, so it is state, not cache), and anything else not obviously regenerable. **The protection applies to EVERY action that removes a worktree — the `git worktree remove` in options A and B AND option A's archive, since the app deletes the session's worktree on archive**: a worktree holding any of these is excluded from removal until the user has named each such path as safe to lose (or has backed it up); when that is the CURRENT worktree, option A is withheld — ask B and C alone with their labels verbatim (as in the degraded form below), say why A is absent, and re-ask step 2 with A once the user has named every such path. An app-made worktree's `.claude/settings*.json` are usually copies of the main checkout's, but the user confirms that, the orchestrator does not assume it.
   - **The current session's app-made worktree cannot be removed from inside it**: `ExitWorktree` is a no-op on worktrees the desktop app created, and the app removes the folder only when the session is archived. What CAN be done in place: `git checkout --detach origin/main` so the run's branch is deletable, then say the folder goes with the archive.
2. **Ask with AskUserQuestion — exactly these three options, in this order, labels verbatim:**
   - **A `清除分支、清除 worktree、封存 session`** — the full cleanup, listed first because it is the usual choice: delete the verified branches (`-d`, or `-D` only for content-verified squash merges), `git worktree remove` the qualifying other worktrees, `git worktree prune`, then `mcp__ccd_session_mgmt__archive_session` with `session_id: "self"` as the LAST action (the app removes the current worktree; the conversation ends). Offered only when the current worktree passed the ignored-files check in step 1. Also archive other idle sessions whose merged PRs the inventory surfaced only if the user names them.
   - **B `清除分支、清除 worktree，不封存`** — the same branch deletion and other-worktree removal, then detach the current worktree onto `origin/main` instead of archiving; its folder stays until the session is archived — state that — and the conversation continues.
   - **C `什麼都不動作`** — report the inventory and stop.
3. **Report** what was removed and what remains, each with its reason. The main checkout (outside a worktree run) being behind `origin/main` is reported with the `git -C <root> pull --ff-only` command to run, never run from inside a worktree. Options A and B never touch the user's other active sessions' worktrees.

**Without the desktop app's tools** (a CLI session, or any session where the `mcp__ccd_*` tools and `<ci-monitor-event>` are absent — check the tool list, do not assume): the phase still runs, degraded as follows. Trigger: `gh pr view <n> --json state` reporting `MERGED`, or the user saying so. Worktree ownership: `git worktree list` only — any worktree other than the current one is left alone unless the user names it. Option A: offered only when `mcp__ccd_session_mgmt__archive_session` exists; otherwise the question carries B and C alone, keeps their labels verbatim, and the report says A is unavailable here and that the current worktree folder can be removed from the main checkout with `git worktree remove <path>` once the session has ended — after the same ignored-files check above.
