# /develop Reference: CODE Development Lifecycle

The full development lifecycle for a code change. You (the `/develop` orchestrator) run every phase in THIS session and hold every user gate yourself — dispatch the `coder` / `tester` / `reviewer` / `security-auditor` agents via the Agent tool, always passing `scope` (`frontend` or `backend`). See `SKILL.md` §1–§3 for hard rules, stop discipline, and the dispatch quick-reference.

## Mode Selection: fix mode vs full cycle

Every code change runs the Code Modification Workflow, in ONE of two sanctioned forms. **Full cycle** (Phases 0–8 below) is the default. **Fix mode** is the lightweight form — the same workflow with reduced ceremony — and is allowed ONLY when EVERY condition below holds.

The conditions are mechanical: check each one, record the answer. Never pick the mode "by judgment" / 視情況 — a condition that is unmet **or unknown** means full cycle.

### Fix-mode eligibility (ALL four must hold)

1. **Single scope.** The change is `frontend` OR `backend` — never both. A full-stack change is always full cycle.
2. **No contract change.** No API contract change (endpoint, method, request/response shape, error `code`) AND no KV schema change (new key pattern, changed value shape, changed TTL).
3. **Diff ≤ 40 lines, production files only.** Measure against the run's OWN base — the merge-base, never the moving tip of `origin/main` — and exclude the test trees:

   ```
   git diff --numstat $(git merge-base origin/main HEAD) -- ':(top)' ':(exclude,top)extension/tests' ':(exclude,top)pwa/tests' ':(exclude,top)worker/tests'
   ```

   Sum BOTH numeric columns (added + deleted) over all rows; that total must be ≤ 40. The `top` magic prefixes keep the pathspecs repo-rooted, so the command is safe to run from ANY subdirectory — a CWD-relative `-- .` run from `worker/` (where a backend verify leaves the shell) matches nothing and silently reports 0 lines, passing the size gate by accident. When the user named a different base branch for the run, substitute it for `origin/main` in the `merge-base` call. **Why the merge-base:** it measures only THIS run's work even when `origin/main` has advanced mid-run or the run continues an existing branch — measuring against a moved `origin/main` would count other people's commits into the 40-line budget. **Why production-only:** the fix-mode regression test's own size must never flip the mode.

4. **No security-sensitive path touched.** No file in the diff matches ANY pattern below. The list is **path-only** — never a per-call or per-symbol judgment about what inside the file was edited:
   - `worker/src/**` — the entire Worker runtime (routes, middleware, services, utils, schemas, kv, index)
   - `extension/src/crypto/**`, `pwa/src/crypto/**` — both ends run the same hash / sync-code logic, so the exclusion is symmetric
   - `extension/src/background/**`
   - `extension/src/dialog/PersonalShelf.tsx`, `extension/src/dialog/usePersonalBooks.ts`, `pwa/src/pages/PersonalShelfPage.tsx`, `extension/src/api/client.ts`, `pwa/src/api/client.ts` — whole files; touching the file at all disqualifies. Both PersonalShelf surfaces are listed because Phase 6's `invariants` trigger covers the FE sharing / save-before-sync flow on EITHER surface (Inv-3 / Inv-5); on the Extension side that flow lives in the `usePersonalBooks` hook, not in the presentational component
   - `shared/src/personal/**` — the PUT/PATCH save decision shared by BOTH ends; one edit here changes save-before-sync behaviour on Extension and PWA at once
   - `.env*`, `wrangler.toml`, `.github/workflows/**`
   - any dependency manifest: `package.json` at any level, `pnpm-lock.yaml`

   A match ⇒ full cycle. No exception, at any diff size.

### Decision timing: predict at entry, measure after every coder return

- **Predict** (before Phase 0): check the four conditions against the ESTIMATED change. That prediction selects the mode for the run.
- **Measure — after EVERY coder return, not only the first.** Re-run the condition-3 measurement verbatim — same `merge-base` base, same test-tree exclusions, both `--numstat` columns summed — and re-check all four conditions against the ACTUAL cumulative diff. Also run `git status --porcelain`: any untracked (`??`) entry under `extension/`, `pwa/`, `worker/`, or `shared/` escalates the run to the full cycle, because an un-added new file is invisible to `git diff` and would otherwise count as 0 lines. The three test trees are the exception — an untracked entry under `extension/tests/`, `pwa/tests/`, or `worker/tests/` NEVER escalates and only earns a `git add` reminder, since test code sits outside the 40-line budget and fix mode's own regression test is normally a brand-new file. This explicitly includes every Fix-Cycle CRITICAL-fix round: a fix round can push the total past 40 lines or drag in a condition-4 path, and that round's measurement escalates the run exactly like the first one would. The measurement, not the prediction, is authoritative.
- **Escalate in place.** When any measurement shows the diff over 40 lines, or any other condition violated, switch to the full cycle FROM THE CURRENT POSITION: phases already completed are NOT re-run; continue through the remaining full-cycle phases (verify-before-test gate, tester, full review, Phase 5 / Phase 6 as applicable). Late escalation (after the tester or the CRITICAL-only review has already run) does NOT re-instate the verify-before-test gate — its purpose has passed. It MUST re-dispatch the `reviewer` for a FULL review of the cumulative diff (SUGGESTIONs tabled per 4.1/4.3); the CRITICAL-only pass does not count as the full-cycle review. State to the user that the mode escalated, which condition tripped, and the measured number.
- Escalation is one-way: a full-cycle run never downgrades to fix mode mid-run.

### Fix-mode flow

Phase 0 branch preflight → `coder` → scope verify (`pnpm typecheck && pnpm lint && pnpm test`; backend prefixes `cd worker &&`) → `tester` per the fix-mode tester rule → re-run the scope verify so the new regression test is included → E2E impact check (frontend scope) → `reviewer`, dispatched normally → Phase 8 (completion report + commit gate).

- **Phase 1 collapses to a single opening presentation.** Restate the pinned root cause (`file:line`) and the acceptance check in the run's opening message, then continue — there is NO separate confirmation stop. The TodoWrite checklist is still maintained (with the fix-mode steps). Phase 1's **bug fast-path** does not apply here: it defers confirmation to the verify-before-test gate, and fix mode has no such gate — the root-cause restatement above replaces it.
- **Phase 2 is structurally N/A** — eligibility condition 2 forbids API-contract and KV-schema changes, so there is no contract to define.
- **Tester dispatch, spelled out.** Dispatch `tester` with `scope`, `target`, `scope_intent: quick`, and `change_summary` (+ the actual diff). The prompt MUST carry this sentence verbatim: "EXACTLY ONE regression test — the single check that is red before the fix and green after it; no coverage expansion." Both halves are load-bearing: `.claude/agents/tester.md` defaults `scope_intent` to `full`, so omitting either the `quick` intent or that sentence gets the coverage expansion fix mode exists to avoid.
- **The E2E impact check is KEPT (frontend scope).** Only the verify-before-test GATE is skipped in fix mode — this check is not. Run the existing **Phase 3 E2E Impact Check** procedure unchanged, in the position it holds there (after the scope verify that includes the new regression test, i.e. once unit/component tests pass): identify whether any changed production file is imported — directly or transitively — by `extension/tests/e2e/` or `pwa/tests/e2e/`; run `npx tsc --noEmit --project tests/e2e/tsconfig.json` in the affected package; on failure dispatch `coder` to fix the breakage (imports, helpers).
- **The `reviewer` is dispatched NORMALLY; only the ORCHESTRATOR is CRITICAL-only.** Pass the usual `scope` / `target` / `business_logic` and do not ask the reviewer to narrow its output — its return format is unchanged (Critical / Suggestions / Observations per `.claude/agents/reviewer.md`). "CRITICAL findings only" describes what YOU do with that return: SUGGESTION findings are never tabled, never presented for a decision, never fixed in-run. They have exactly ONE outlet — every SUGGESTION that grades **P0 or P1** against `.claude/rules/change-triage.md` is recorded through that file's "Disposition of out-of-scope P0/P1" path (`gh issue create`, tier label, `file:line`, consequence of leaving it unfixed), **whether or not it belongs to the current task**. In-scope is deliberately routed the same way: fix mode declines to widen the run, so without that outlet an in-scope P0/P1 would be silently dropped. P2 items and non-goals are dropped silently, as always. Never a worktree, never a follow-up task chip, never scope expansion.
- **CRITICAL findings are auto-fixed** exactly as in §4.2 — fix → re-verify → re-review only the changed files — with no user gate.
- **Skipped in fix mode:** the Phase 3 verify-before-test gate, Phase 5 (cross-scope validation — unreachable, fix mode is single-scope), Phase 6 (security scan), and Phase 7 (retro). Be honest about what skipping Phase 6 costs: condition 4 excludes every path that would trigger a security-auditor-specific scope (`api`, `crypto`, `secrets`, `deps`, `invariants` per Phase 6's scope map), so what fix mode forgoes is the generic `code` / `extension` sweep over a ≤ 40-line, CRITICAL-reviewed diff — a documented residual, accepted deliberately.
- **Not skipped:** Phase 8. **The Phase 8 commit gate is fix mode's single user gate** — the commit is ALWAYS an explicit user question, in either mode. The Phase 8 completion report MUST state that the run used fix mode, list what fix mode skipped (the verify-before-test gate, Phase 5, Phase 6, Phase 7), and state how many P0/P1 SUGGESTION issues were opened via the disposition path — zero is stated as zero, never left implicit. Omitting that disclosure is a defect, not a tidier report.

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

## Phase 1: Requirements Analysis (collaborative — iterate until confirmed)

1. Read the requirement carefully.
2. **Verify cited specifics.** Externally supplied lists (audit findings, handler or call-site inventories) and quoted concrete examples (URLs, payloads, error strings) are leads, not facts: re-enumerate lists from source — grep BOTH `extension/` and `pwa/` so mirror surfaces are not missed — and execute examples before any of it enters an agent prompt or a doc. What stays unverified is marked unverified, never stated as fact.
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
   - **Open questions** needing the user's decision.
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
2. After the coder returns, run the scope's verify: frontend `pnpm typecheck && pnpm lint`; backend `cd worker && pnpm typecheck && pnpm lint`. (NOT the full test suite yet — new behavior isn't test-covered.) Then stage the accepted output (`git add <paths>`) so the index snapshots the delivery; any destructive experiment on tracked files (tripwire, mutation check) requires staged state or a scratchpad copy first — never mutate-then-checkout over unstaged agent work.
3. **Verify-before-test gate [STOP — manual verification].** Before any test is written, present:
   - a concise summary of what the coder changed (files + behavior + affected states),
   - how the user can verify it (frontend: what to click/observe; backend: a curl example or KV state to inspect),
   - instructions that run as written: name the execution context (shell, directory, DevTools context), state that the change exists only locally — with the local URL / launch command — and, in a worktree, the worktree path (the main checkout serves different code). For backend scope, default to the orchestrator RUNNING the verification (curl / KV inspection) and presenting observed results; copy-paste commands are the fallback,
   - **any rate limit / quota the tested flow touches** (limit, window, retry interval) — so throttling (e.g. a 429) isn't misread as a functional defect and repeated manual retries don't burn the quota,

   then ask the user to confirm it's correct OR point out fixes. **Rationale:** writing tests against unconfirmed behavior forces repeated rewrites. End with the Stop Block.
   - Fixes needed → dispatch `coder` to fix, re-run typecheck/lint, re-present this gate. **Batch feedback:** when one gate round returns several small UI remarks, fold them into ONE coder dispatch (file-disjoint) and one tester pass afterward — never one full round-trip per remark.
   - Confirmed correct → proceed to step 4.

4. Dispatch **`tester`** with `scope`, `target`, `change_summary` (+ the actual diff). Production code is frozen once the gate confirms, so the tester and the Phase 4 `reviewer` MAY be dispatched in parallel — hold any reviewer finding against test code until the tester returns; for small diffs the first-round review may also run parallel with the Phase 6 scan (Fix-Cycle changes then get a re-scan of the changed files).
5. Run full verify: frontend `pnpm typecheck && pnpm lint && pnpm test`; backend `cd worker && pnpm typecheck && pnpm lint && pnpm test`. Run the full suite ONCE, here — do not re-run it when an agent just reported it green, and never let it overlap an agent's own run (two concurrent full suites cause CPU-contention flakes). Repeated stress runs (flake reproduction, N-times-green acceptance) are the orchestrator's job after the agent returns.

**Gate** — all must pass before Phase 4 acts on findings: coder done + user-confirmed; tester done; typecheck/lint/test green; E2E impact check (below) passes. (The reviewer dispatch itself may start early per step 4 — the gate then blocks Fix-Cycle actions, not the dispatch.)

**E2E Impact Check** (after unit/component tests pass, frontend scope):

1. Identify whether any changed production files are imported (directly/transitively) by E2E tests (`extension/tests/e2e/`, `pwa/tests/e2e/`).
2. Run E2E typecheck: `npx tsc --noEmit --project tests/e2e/tsconfig.json` in the affected package.
3. On failure, dispatch `coder` to fix the breakage (imports, helpers). This catches compile-time breaks early; it does NOT require running the full E2E suite locally.

## Phase 4: Review + Fix Cycle

Dispatch **`reviewer`** (`scope`, `target` = changed files, `business_logic`) per scope. Then repeat **Review → Fix → Re-review** until clean. Maintain a running **Fix Cycle Log** of every CRITICAL auto-fixed and every SUGGESTION accepted/skipped — present it each round and on exit.

**Base re-check before the first review dispatch:** `git fetch origin` + `git log HEAD..origin/main`. If upstream moved — especially onto files this run touches — rebase/ff first so reviewer and auditor diff against reality: a stale base turns upstream commits into phantom findings. If not yet rebased, point their `base_ref` at the merge-base, never at the moved `origin/main` tip.

**In-round adjudication:** every coder/tester return's Open Questions and in-scope side observations get an explicit disposition THIS round (fix now / accept as residual / route per `.claude/rules/change-triage.md`), recorded in the Fix Cycle Log — never left for a later phase to rediscover. Orchestrator-discovered defects enter the log with the same standing as reviewer findings. Before turning a reviewer coverage/absence claim into a prescription, verify it against the target file yourself.

**Fix-round handoffs:**

- **Behavior handoff** (generalizes the former rename handoff): when a fix renames a production export OR changes behavior that existing tests pin, first grep the affected code path / error code / field across the test trees, then the coder prompt lists the expected-red tests and the new expectation; the follow-up tester prompt carries that list verbatim — one coder→tester round, no discovery pass.
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

Run **once** after the whole feature is complete (all sub-tasks done, cross-scope validation passed) and **before the commit gate**, not per sub-task.

1. Pick scope(s) from all changed files since the feature began:
   - `extension/src/crypto/` → `crypto`; `worker/src/` → `api`; `extension/src/` → `code` + `extension`; `pwa/src/` → `code`; `.env*`/`wrangler.toml`/CI/CD → `secrets`; deps changed → `deps`; multiple areas → `full`.
   - **Business-logic / invariant surfaces → also add `invariants`** (Dimension 8): any change under `worker/src/routes/` (family / bookshelf / member / user / auth) or `worker/src/middleware/auth`, or any FE change to the sharing / save-before-sync flow (`PersonalShelf`, `api/client` sharing calls). These carry the security-UX invariants (Inv-1..5), which the plain `api` / `code` scopes do **not** cover.
2. Dispatch **`security-auditor`** with that scope (set) plus `mode: changed` and `base_ref: origin/main`, so the scan focuses on the feature's diff + its blast radius instead of re-scanning the whole repo. (Use `mode: repo` only for a deliberate periodic full audit, never for a routine post-feature scan.)
3. Present findings.
4. **CRITICAL** → flag with remediation; recommend fixing before merge (user acknowledgement required). **WARNING** → report, non-blocking.

This phase auto-starts (no confirmation to begin), but CRITICAL findings require user acknowledgement.

## Phase 7: Retro (on explicit user request only)

The run retrospective is **NOT offered by default and MUST NOT be proactively suggested** — no "要不要做 retro？" at the end of a run, and no retro option inside any AskUserQuestion batch. It runs ONLY when the user explicitly asks for one (mid-run or at the end).

When the user asks: read `references/retro.md` and follow it in **this session** (it needs the full conversation history — an isolated subagent cannot write it). The report lands in `.claude/reports/<MMDD_HHMM>.md` **before Phase 8's commit gate**, so it rides along in the feature's commit — no follow-up `chore(retro)` commit needed. The retro writes conclusions only; applying its proposals is `/distill`'s job (periodic, user-invoked), never done in-run.

## Phase 8: Complete

1. Re-present the Fix Cycle 總結 (+ any cross-scope additions + the security-scan verdict). In fix mode, render the security-scan line as 「不適用（fix mode — no scan was run）」 — never drop the line, never state a verdict no scan produced.
2. List changed files (all scopes) + final verification status.
3. End with a single **prose headline paragraph** consolidating the outcome.
4. **Base re-check:** `git fetch origin` + `git log HEAD..origin/main` — long runs go stale while parallel sessions merge. If main moved, rebase/ff and re-run the scope verify before committing; surface the rebase in the report.
5. **Diff hygiene:** `git status --short` over the whole tree — the set to stage must equal this feature's expected file list. Stray entries (formatter churn, EOL rewrites, another task's leftovers) are inspected and restored, never swept into the commit.
6. `git add` explicit paths only (including the retro report, if one was written).
7. Ask the user about committing. (Commit is ALWAYS an explicit user question — never auto-run.)
