# Run retrospective (reference)

Lazy-loaded by `/develop` when the user explicitly requests a retro, before the commit
gate (code-cycle Phase 7 / design Deliver). Runs in the **main session** — it needs the
full conversation history (dispatches, gates, Fix Cycle rounds, user corrections) that an
isolated subagent cannot see. Read this only when the user explicitly requests a retro;
never load it preemptively, never suggest it proactively, never auto-run.

Instructions are English; the report file and all user-facing output are 繁體中文.
Read-only toward source code: cite `file:line`, never paste long excerpts.

## 1 Collect (session evidence only)

- Dispatch history: per phase — which agents (coder / tester / reviewer /
  security-auditor / designer), parallel vs serialized, retries.
- Gates: requirements-confirmation rounds, mockup gate, verify-before-test retries,
  Fix Cycle rounds (CRITICAL auto-fixed count, SUGGESTION adopted/rejected),
  cross-scope findings, security-scan verdict.
- User corrections / interruptions (verbatim) — each is a U# candidate.
- The run's Fix Cycle Log + TodoWrite checklist; branch `git diff --stat`.
- Context attribution (countable proxies, not a guessed %): agent dispatches consumed,
  self-reads of source files (count only — moo permits orchestrator reads; the count is
  recorded so a trend can surface, it is NOT a violation), the single biggest consumer
  category, and one concrete lever to cut next run.
- Don't restate what the repo already records (git history, CHANGELOG, rules); point at it.

## 2 Write the report

Path: `.claude/reports/<MMDD_HHMM>.md` (24h clock). Lesson ids are stamp-scoped:
`L<MMDD_HHMM>-n` (e.g. `L0714_1830-1`) — unique without scanning other reports.
Five sections:

1. **Run 概要** — table with integer counts: intent route (CODE / DESIGN / MIXED),
   dispatch count (total + per agent type), Fix Cycle rounds, gate rounds
   (需求確認 / verify-before-test / SUGGESTION 決策), diff stat, wall-clock bottleneck
   (slowest dispatch, seconds).
2. **卡點與摩擦** — U# (user corrections, verbatim quote) and G# (gate retries, failed
   verifications, rework), each with evidence.
3. **改進提案** — by lesson type:
   - **Flow-structural** L#: `target=<git-tracked path> | sketch=<one line> |
status=proposed`, naming the file (`.claude/rules/*.md`, `.claude/skills/**`,
     `.claude/agents/**`, `AGENTS.md`), or `不提升：<理由>`. Defer anchors / exact
     wording to apply time (`/distill`) — adoption is low, up-front precision is waste.
   - **執行槓桿 (no flow gap)** E#: run-agnostic habit that cuts time / imprecision /
     context next run. One actionable line each — not a flow edit.
4. **Skill / Agent 增減建議** — remove / slim / add candidates with rationale, from the
   user's angle: what would make the next run better.
5. **三軸 KPI** — fixed `key: value` lines, countable integers per axis, no adjectives.
   No cross-report comparison: each report stands alone — a lesson recurring across runs
   surfaces by independently reappearing in each report; `/distill` reads recurrence as
   the strongest adoption signal.
   - `speed`: `bottleneck_seconds` (slowest dispatch) + `serialized_legs` (legs run
     serially that could have been parallel).
   - `precision`: `requirement_rounds` + `critical_count` (auto-fixed CRITICALs) +
     `suggestion_adopted/proposed` + `rework_rt` (verify-before-test / re-review
     round-trips).
   - `context`: `dispatches` + `self_reads` (neutral count, see §1) + `top_consumer`
     (biggest category) + one cuttable lever. No self-measured token %; countable
     proxies only.
   - `meta`: `patch_proposed` (this report's L# count). Adoption is tracked by
     `/distill`, not here.

## 3 Conclusions only — no apply step

The retrospective writes the report and STOPS. It NEVER asks, after writing, whether to
apply skill / rules / memory patches — proposals live in the report as conclusions;
applying them is `/distill`'s job (periodic, user-invoked) or a separate explicit user
request.

Proposal-writing principles (for §2.3 L# proposals — inheritable by a fresh clone with
zero context, not reliant on any one developer's memory):

- Every patch proposal names a git-tracked target — session memory is never the carrier
  of a rule.
- No duplicates: check the target file first; propose fixing/deleting stale entries,
  don't stack.
- **Cut before add**: net growth in a flow file needs a stated reason.
- Instruction files stay English; terse over thorough.
