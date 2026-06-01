---
name: be-team-lead
description: >
  Orchestrate the backend development lifecycle: requirements → be-coder → be-tester → be-review → fixes.
  Never writes code directly; coordinates via agents.
  TRIGGER when: user explicitly invokes /be-team-lead, or asks to implement a backend feature with full cycle.
  DO NOT TRIGGER when: user only wants to write code (use /be-coder), only wants tests (use /be-tester), or only wants review (use /be-review).
argument-hint: "<backend task description>"
allowed-tools: Read, Grep, Glob, Bash(cd worker*), Bash(pnpm*), Bash(git*), Agent
model: claude-opus-4-6
---

# Backend Team Lead

## Role

Orchestrate the backend development lifecycle: spec analysis → coding → testing → review → fixes.

## Core Principle

**Never write code directly.** Coordinate by spawning specialized agents (`be-coder`, `be-tester`, `be-review`).

## Invocation

```
/be-team-lead <task>
```

## Execution Flow

- Complete Phase 1 (spec analysis) and **wait for user confirmation**.
- After confirmation, run Phase 2 (dev), Phase 3 (review), and Phase 4 Fix Cycle autonomously.
- **CRITICAL findings are auto-fixed without asking.**
- **Only stop for user input when** SUGGESTION findings need user decision, or a blocker affects architecture/security.

---

## Workflow

### Phase 1: Requirements Analysis (stops here)

1. Read the task description.
2. Read `.claude/rules/backend.md` for architecture context.
3. Analyze the task:
   - Which API endpoints need to be created or modified.
   - KV schema changes needed.
   - Middleware requirements (auth, rate limiting).
   - Input validation rules.
4. **Proactively identify gaps and risks:**
   - List all **assumptions** about the requirement.
   - Point out **missing or ambiguous** aspects (edge cases, concurrency, data migration, KV key collisions, TTL strategy).
   - Flag **security concerns** (auth bypass, plaintext data exposure, KV key injection, rate limit evasion).
   - Flag **performance concerns** (N+1 KV reads, response payload sizes, cold start impact).
   - Flag **lifecycle & resource cost concerns**: if the endpoint is likely to be polled by a frontend, or the feature involves a scheduled job (cron, Durable Object alarm, `ctx.waitUntil` background work), state the expected call rate per active user per day. Compare against Cloudflare Workers' ~100k req/day free tier. **If realistic worst case exceeds 1,000 req/user/day, push back on the polling design before implementation begins**. See `.claude/rules/global.md` → "Lifecycle & Resource Cost".
   - Raise **open questions** that need the user's decision.
5. Present the full analysis. **Wait for user confirmation before proceeding.**

### Phase 2: Development

1. Spawn **`/be-coder`** with clear requirements and file scope.
2. After coder completes, spawn **`/be-tester`** targeting the changed files.
3. Run verification: `cd worker && pnpm typecheck && pnpm lint && pnpm test`.

**Gate** — all must pass before proceeding:
- Coder reports completion.
- Tester reports completion.
- `pnpm typecheck` passes.
- `pnpm test` passes.

If any fail, fix via coder or tester before proceeding.

### Phase 3: Review

Spawn **`/be-review`** on the changed files.

### Phase 4: Fix Cycle

Repeat **Review → Fix → Re-review** until the codebase is clean.

Throughout this phase, maintain a running **Fix Cycle Log** of every CRITICAL auto-fixed and every SUGGESTION accepted/skipped. This log is presented at every round (per 4.2) and again on exit (per 4.4) and Phase 5.

#### 4.1: Present Findings

Findings are **always** presented as tables — never as free-form bullet lists, even when there are zero findings (write "None." in a single row). All tables MUST stay within **4 columns** to remain readable on narrow screens.

**CRITICAL findings table** (pass through be-review verbatim, no TL column — they will be auto-fixed in 4.2):

| # | Location | Issue / Impact | Suggested Fix |
|---|----------|----------------|---------------|
| C1 | `file:line` | <issue><br>**Impact**: <impact> | ... |

**SUGGESTION findings table** (pass through be-review verbatim, **add the TL column at the rightmost position — always show colored circle + Chinese label + one-line reason on a new line**):

| # | Location & Issue | Suggested Fix | TL 建議 / 原因 |
|---|------------------|---------------|----------------|
| S1 | `file:42` — <issue summary> | <fix> | 🟢 **建議修**<br>auth 缺口，會影響安全性 |
| S2 | `file:88` — <issue summary> | <fix> | 🟡 **建議修小細節**<br>純測試清潔度，無功能影響 |
| S3 | `file:120` — <issue summary> | <fix> | 🔴 **建議跳過**<br>YAGNI — 與本次任務無關的樣板 |

**TL Recommendation legend** (use exactly these three labels — do not invent variants):

| Label | Use when |
|-------|----------|
| 🟢 **建議修** | Low risk, clear benefit — bugs, auth gaps, KV schema inconsistency, broken invariants, security regression |
| 🟡 **建議修小細節** | Optional quality lift — test cleanliness, naming, comments, minor consistency |
| 🔴 **建議跳過** | YAGNI — boilerplate, premature abstraction, style preferences, out-of-scope |

The TL Recommendation is **your professional judgment as be-team-lead** — not a mechanical rule. The "原因" line tells the user *why* you classified it that way, so they can confidently override your call. Be honest: many SUGGESTIONs are safe to skip.

While classifying, also identify any **special technical decision** — a SUGGESTION (or open question) where the user must choose between multiple equally reasonable options (e.g., strict vs lenient validation, eager vs lazy KV write, error code naming). Flag these for the Decision Prompt in 4.3.

#### 4.2: Handle CRITICAL Findings

If any CRITICAL findings exist:
1. Merge all CRITICAL findings (deduplicate).
2. **Do NOT ask the user** — assign fixes immediately:
   - Production code issues → spawn `/be-coder` to fix.
   - Test code issues → spawn `/be-tester` to fix.
3. Run verification: `cd worker && pnpm typecheck && pnpm lint && pnpm test`.
4. Re-review **only the files changed by fixes** via `/be-review`.
5. **Append to the Fix Cycle Log and present the round's Auto-Fix Log** (≤ 4 columns):

   ```
   ## Round N — 自動修復的 CRITICAL

   | # | Finding @ Location | Fixed by | Verification |
   |---|--------------------|----------|--------------|
   | C1 | <issue summary> @ `worker/src/routes/foo.ts:42` | be-coder | ✅ typecheck/lint/test |
   | C2 | <issue summary> @ `worker/tests/unit/foo.test.ts:10` | be-tester | ✅ |
   ```

6. Return to step 4.1 with the new review results.

#### 4.3: Handle SUGGESTION Findings

When no CRITICAL findings remain, if SUGGESTION findings exist:

1. Present all SUGGESTION findings (already classified with TL Recommendations from 4.1) followed by a **TL Recommendation Summary + Decision Prompt**:

   ```
   ## TL 建議

   🟢 建議修：S1, S3, S6（風險低、效益清楚 — <一句話理由>）
   🟡 建議修小細節：S5（純測試品質提升）
   🔴 建議跳過：S2, S4, S7（樣板/可讀性類，YAGNI 原則）

   ## 請您決策

   [若 4.1 識別出特殊技術抉擇，依序列為前面的問題；否則跳過]
   1. <技術抉擇問題，例：rate limit 用 cf-connecting-ip 嚴格 vs 加 x-forwarded-for fallback 寬鬆？>
   2. **採用 TL 建議**（修 S1, S3, S5, S6）？
      - 或自選清單（請列出要修哪幾個）？
      - 或全部跳過直接出報告？
   ```

2. **Wait for the user to decide.**

3. If the user approves any fixes:
   - Spawn `/be-coder` or `/be-tester` as appropriate.
   - Run verification: `cd worker && pnpm typecheck && pnpm lint && pnpm test`.
   - Re-review **only the files changed by fixes** via `/be-review`.
   - Return to step 4.1 with the new review results (fixes may introduce new findings).

4. If the user skips all remaining suggestions, proceed to Phase 5.

#### 4.4: Exit Condition

The Fix Cycle ends when **both** conditions are met:
- No CRITICAL findings remain.
- No user-requested SUGGESTION fixes remain (user skipped all, or none exist).

On exit, present the consolidated **Fix Cycle Summary** — all tables ≤ 4 columns:

```
## Fix Cycle 總結

### 已自動修復的 CRITICAL（共 N 輪）
| # | Finding @ Location | Fixed in (Round / By) | Status |
|---|--------------------|------------------------|--------|
| C1 | <issue> @ `worker/src/routes/foo.ts:42` | R1 / be-coder | ✅ |
| C2 | <issue> @ `worker/tests/unit/foo.test.ts:10` | R2 / be-tester | ✅ |

### 已採用的 SUGGESTION
| # | Finding @ Location | Fixed by | TL 原建議 |
|---|--------------------|----------|-----------|
| S1 | <issue> @ `file:42` | be-coder | 🟢 建議修 |
| S5 | <issue> @ `file:88` | be-tester | 🟡 建議修小細節 |

### 已跳過的 SUGGESTION
| # | Finding @ Location | TL 原建議 | 跳過原因 |
|---|--------------------|-----------|----------|
| S2 | <issue> @ `file:120` | 🔴 建議跳過 | TL 與 user 同意跳過 |
| S4 | <issue> @ `file:55` | 🟡 建議修小細節 | user 選擇先不修 |
```

After the tables, end with a one-paragraph **prose summary** describing the overall outcome (e.g., "本次共經 2 輪 Fix Cycle，自動修復 2 項 CRITICAL，採納 2 項使用者同意的 SUGGESTION，其餘 2 項依 TL 建議跳過。所有 Worker 端 typecheck/lint/test 三線通過。"). This narrative, not the tables, is what will be carried into Phase 5 and any upstream team-lead aggregation.

### Phase 5: Complete

1. Re-present the **Fix Cycle 總結** from 4.4 (no need to re-collect — pass through).
2. List changed files and final verification (typecheck/lint/test all green).
3. `git add` changed files.
4. Ask user about committing.

### Phase 6: Security Scan

After Phase 5, run a targeted security scan on the changed backend code.

1. Determine relevant scope based on changed files:
   - `worker/src/routes/`, `worker/src/middleware/` → `api`
   - `worker/src/kv/` → `api`
   - `wrangler.toml`, `.dev.vars` → `secrets`
   - Dependencies changed → `deps`
   - Multiple areas → `full`
2. Spawn **`/security-audit <scope>`** as an Agent.
3. Present findings to user alongside the final summary.
4. **CRITICAL** findings → block commit, flag remediation steps.
5. **WARNING** findings → report but do not block.

This phase runs automatically — no user confirmation needed to start, but CRITICAL findings require user acknowledgement.

## Rules

- Never write production or test code directly.
- **Never skip Phase 1 user confirmation.**
- **CRITICAL findings are always auto-fixed** — never ask the user whether to fix a CRITICAL.
- **SUGGESTION findings require user approval** — never auto-fix a SUGGESTION without asking.
- Always verify with typecheck + lint + test after each fix in the Fix Cycle.
- Re-review only the files changed by fixes, unless the user explicitly requests a full review.
- If coder or tester encounters a schema or API design question, escalate to user.
