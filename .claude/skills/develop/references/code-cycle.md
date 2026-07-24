# /develop Reference: CODE Development Lifecycle

The full development lifecycle for a code change. You (the `/develop` orchestrator) run every phase in THIS session and hold every user gate yourself — dispatch the `coder` / `tester` / `reviewer` / `security-auditor` agents via the Agent tool, always passing `scope` (`frontend` or `backend`). See `SKILL.md` §1–§3 for hard rules, stop discipline, and the dispatch quick-reference.

## Phase 0: Branch Preflight (before any code)

Guarantee the change lands on its own clean branch off `origin/main`, so another task's commits can never contaminate this PR's diff. Do this once, up front — silently if already clean, otherwise fix it before Phase 1.

1. `git fetch origin`.
2. **Base:** unless the user named a base branch or asked to continue an existing branch, base the task on `origin/main`.
3. **Isolation check:** run `git log --oneline origin/main..HEAD`. If it is non-empty — the current worktree/branch already carries unrelated commits — do NOT commit on top. Cut a fresh branch from `origin/main`: `git checkout -b <type>/<slug> origin/main` (or create a new worktree from `origin/main`).
4. **Name it meaningfully:** `<type>/<short-kebab-slug>` — conventional type (`feat`/`fix`/`refactor`/`docs`/`test`/`chore`) + a concise English task slug (e.g. `fix/save-before-sync`). Never keep an opaque auto-generated worktree name (`claude/angry-moore-3651ca`) as the PR branch — rename first.
5. Re-confirm `git log --oneline origin/main..HEAD` is empty before starting Phase 1. See `.claude/rules/global.md` → "Branch & Worktree Hygiene".
6. **Worktree tasks:** when the task runs in a dedicated worktree, start EVERY agent prompt by restating the worktree's absolute path and forbidding any write to the main checkout.

## Phase 1: Requirements Analysis (collaborative — iterate until confirmed)

1. Read the requirement carefully.
2. **Bug / incident intake** (bug-type requests only — skip for features):
   - **Surface matrix first.** Before reading any code, establish WHICH surface is broken: Extension-Chrome / Extension-Firefox / PWA × device × symptom. Investigate only the broken surface — don't burn context reading an unaffected one.
   - **Delegate broad scans.** Multi-file investigation sweeps go to an `Explore` agent that returns conclusions; you self-read only the 3–5 key files that anchor the diagnosis.
   - **Masked fields are unknowns.** If you asked the user to redact a sensitive field (token, id), record it as "existence unknown" — never treat its absence from pasted output as evidence.
   - **Fast-path** (single scope + root cause already pinned with `file:line` evidence + no API/schema change): you MAY fold the requirements analysis into the Phase 3 verify-before-test gate presentation instead of a separate confirmation stop, and write the pinned root cause into the coder prompt.
3. Read `docs/project-plan.md` and `docs/architecture.md` for context (skip if absent).
4. Break the requirement into work-items, each tagged **frontend** (Extension UI, Content Script, crypto, PWA) or **backend** (Worker API, KV schema, middleware), plus **shared concerns** (sync code format, API contract).
5. **Proactively identify gaps and risks** — present these to the user:
   - **Assumptions** you are making.
   - **Missing / ambiguous** aspects: edge cases, error/empty/loading states, UX flows, concurrency, data migration, KV key collisions, TTL strategy.
   - **Security concerns** (frontend: XSS, `dangerouslySetInnerHTML`, secrets in client, `chrome.storage` exposure; backend: auth bypass, plaintext exposure, KV key injection, rate-limit evasion).
   - **Performance concerns** (frontend: needless re-renders, bundle size; backend: N+1 KV reads, payload size, cold start).
   - **Lifecycle & resource cost** — for ANY feature with FE polling/auto-refresh, BE scheduled jobs, or background sync: back-of-envelope cost (1 user × 24h × N devices) vs Cloudflare Workers' ~100k req/day free tier. **If realistic worst case > 1,000 req/user/day or polling is unbounded → mandate on-demand or visibility-gated design and flag it now, not at review.** See `.claude/rules/global.md` → "Lifecycle & Resource Cost".
   - **Open questions** needing the user's decision.
6. **Mockup gate (optional).** If the feature introduces a new screen / dialog / overlay or significantly reshapes one, offer to dispatch the `designer` agent for a Pencil mockup before coding (user decides; skip for string/styling/internal changes). On yes, dispatch `designer` with `request` + `context`, relay its screenshot + annotations, iterate to approval, then continue.
7. Present the full analysis. **Wait for user confirmation before proceeding.** (Bug fast-path per step 2 may defer this to the verify-before-test gate.)

## Phase 2: API Contract (full-stack features only)

If the feature spans frontend and backend:
1. Define the contract: endpoints, HTTP methods, request/response shapes, error codes.
2. Document it in the work-item breakdown — both scopes code against it in parallel.

## Phase 3: Development

For each scope in play (frontend, backend — parallelize when file-disjoint):

1. Dispatch **`coder`** with `scope`, `requirements`, `files`.
2. After the coder returns, run the scope's verify: frontend `pnpm typecheck && pnpm lint`; backend `cd worker && pnpm typecheck && pnpm lint`. (NOT the full test suite yet — new behavior isn't test-covered.)
3. **Verify-before-test gate [STOP — manual verification].** Before any test is written, present:
   - a concise summary of what the coder changed (files + behavior + affected states),
   - how the user can verify it (frontend: what to click/observe; backend: a curl example or KV state to inspect),
   - **any rate limit / quota the tested flow touches** (limit, window, retry interval) — so throttling (e.g. a 429) isn't misread as a functional defect and repeated manual retries don't burn the quota,

   then ask the user to confirm it's correct OR point out fixes. **Rationale:** writing tests against unconfirmed behavior forces repeated rewrites. End with the Stop Block.
   - Fixes needed → dispatch `coder` to fix, re-run typecheck/lint, re-present this gate. **Batch feedback:** when one gate round returns several small UI remarks, fold them into ONE coder dispatch (file-disjoint) and one tester pass afterward — never one full round-trip per remark.
   - Confirmed correct → proceed to step 4.
4. Dispatch **`tester`** with `scope`, `target`, `change_summary` (+ the actual diff).
5. Run full verify: frontend `pnpm typecheck && pnpm lint && pnpm test`; backend `cd worker && pnpm typecheck && pnpm lint && pnpm test`.

**Gate** — all must pass before Phase 4: coder done + user-confirmed; tester done; typecheck/lint/test green; E2E impact check (below) passes.

**E2E Impact Check** (after unit/component tests pass, frontend scope):
1. Identify whether any changed production files are imported (directly/transitively) by E2E tests (`extension/tests/e2e/`, `pwa/tests/e2e/`).
2. Run E2E typecheck: `npx tsc --noEmit --project tests/e2e/tsconfig.json` in the affected package.
3. On failure, dispatch `coder` to fix the breakage (imports, helpers). This catches compile-time breaks early; it does NOT require running the full E2E suite locally.

## Phase 4: Review + Fix Cycle

Dispatch **`reviewer`** (`scope`, `target` = changed files, `business_logic`) per scope. Then repeat **Review → Fix → Re-review** until clean. Maintain a running **Fix Cycle Log** of every CRITICAL auto-fixed and every SUGGESTION accepted/skipped — present it each round and on exit.

Findings are **always tables**, never free-form bullets (write "None." in a single row when empty). **All tables ≤ 4 columns** for narrow terminals.

### 4.1 Present Findings

**CRITICAL** (pass through reviewer verbatim, no TL column — auto-fixed in 4.2):

| # | Location | Issue / Impact | Suggested Fix |
| --- | --- | --- | --- |
| C1 | `file:line` | <issue><br>**Impact**: <impact> | ... |

**SUGGESTION** (pass through verbatim; add the rightmost **TL 建議 / 原因** column — colored circle + Chinese label + one-line reason):

| # | Location & Issue | Suggested Fix | TL 建議 / 原因 |
| --- | --- | --- | --- |
| S1 | `file:42` — <issue> | <fix> | 🟢 **建議修**<br><reason> |
| S2 | `file:88` — <issue> | <fix> | 🟡 **建議修小細節**<br><reason> |
| S3 | `file:120` — <issue> | <fix> | 🔴 **建議跳過**<br><reason> |

**TL Recommendation legend** (use exactly these three — no variants):

| Label | Use when |
| --- | --- |
| 🟢 **建議修** | Low risk, clear benefit — bugs, type/auth/KV-schema inconsistency, security gaps, broken invariants |
| 🟡 **建議修小細節** | Optional quality lift — test cleanliness, naming, comments, minor consistency |
| 🔴 **建議跳過** | YAGNI — boilerplate, premature abstraction, style preference, out-of-scope |

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
   🟡 建議修小細節：S5
   🔴 建議跳過：S2, S4（YAGNI）

   ## 請您決策
   [若有特殊技術抉擇，列為前面的問題]
   1. <技術抉擇問題…>
   2. 採用 TL 建議（修 S1, S3, S5）？／自選清單？／全部跳過直接出報告？
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

## Phase 7: Retro Offer (before the commit gate)

After Phase 6's findings are presented, offer the run retrospective **ONCE** (user decides; never auto-run; declined → don't re-offer this run). On yes, read `references/retro.md` and follow it in **this session** (it needs the full conversation history — an isolated subagent cannot write it). The report lands in `.claude/reports/` **before Phase 8's commit gate**, so it rides along in the feature's commit — no follow-up `chore(retro)` commit needed. The retro writes conclusions only; applying its proposals is `/distill`'s job (periodic, user-invoked), never done in-run.

## Phase 8: Complete

1. Re-present the Fix Cycle 總結 (+ any cross-scope additions + the security-scan verdict).
2. List changed files (all scopes) + final verification status.
3. End with a single **prose headline paragraph** consolidating the outcome.
4. `git add` changed files (including the retro report, if one was written).
5. Ask the user about committing. (Commit is ALWAYS an explicit user question — never auto-run.)
