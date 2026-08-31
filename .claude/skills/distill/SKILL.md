---
name: distill
description: >
  Distill accumulated retrospective reports (.claude/reports/*.md) into durable project
  rules. Aggregates L# / E# / skill-change proposals across all reports, prioritizes
  lessons recurring in multiple reports, verifies each proposal against its current
  target file (stale ones get 作廢), gets per-item adoption decisions from the user,
  applies adopted patches to their git-tracked targets (.claude/rules/, .claude/skills/,
  .claude/agents/, AGENTS.md), then clears consumed reports. Touches ONLY
  process/instruction files — never production code.
  TRIGGER when: user invokes /distill, or asks to 蒸餾 / consolidate retro reports /
  apply accumulated retro proposals.
  DO NOT TRIGGER when: user wants a retrospective of the CURRENT session (that is
  /develop's retro, run only on explicit user request), or wants any production code
  change (/develop).
argument-hint: (none)
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git*), Bash(ls*), Bash(rm*), AskUserQuestion, TodoWrite
model: opus
---

# /distill — fold retro reports into durable rules, then clear them

Reports in `.claude/reports/` are volatile raw material; the durable product is the
project's instruction files. You aggregate, verify, let the user decide, apply, and
clear. All user-facing output is **繁體中文（台灣）**.

## Hard rules

- **Process files only.** Legal targets: `.claude/rules/*.md`, `.claude/skills/**`,
  `.claude/agents/**`, `AGENTS.md` (`CLAUDE.md` is a symlink to it — always edit
  `AGENTS.md`). NEVER touch `extension/`, `pwa/`, `worker/`, `site/`, or tests. A
  proposal targeting production code is surfaced as「需另開 /develop 任務」, never
  applied here.
- **User decides every adoption.** No auto-apply, not even "obvious" items. Your TL
  建議 column is advice; the triage gate is the decision.
- **Cut before add.** Net growth in any flow file needs a stated reason; prefer
  rewriting or deleting a stale rule over stacking a new one.
- **Staleness check before adoption.** Read the current target first: if the rule
  already exists, or the underlying problem was since fixed, mark the proposal 作廢
  with evidence instead of applying it.
- Instruction files stay English, terse; user-facing docs 繁體中文.
- **Deleting reports is destructive** — only after explicit user confirmation, and only
  reports whose every proposal is resolved.
- Commit is ALWAYS an explicit user question — never auto-run.

## Workflow

### Phase 1 — Inventory

Glob `.claude/reports/*.md`. None → report「沒有待蒸餾的報告」and stop. Otherwise read
all reports and keep a TodoWrite checklist of the phases.

### Phase 2 — Aggregate & verify

Build ONE ledger across all reports:

- Every **L#** row: id, target, sketch, source report(s). Skip rows already marked
  `status=applied` or `status=rejected:*`.
- Every **E#** lever and **Skill/Agent 增減建議** entry. These lack a target — propose
  one: a `.claude/rules/*.md` section for generalizable habits; 建議寫入使用者記憶 for
  personal preferences (you do not write memory yourself — recommend it).
- **Recurrence**: the same theme appearing in ≥2 independent reports (match by meaning,
  not literal text). Recurrence is the strongest adoption signal — say so in the TL 建議.
- **Verification pass**: read each proposal's current target file and classify:
  `可套用` / `已存在（作廢）` / `已過時（作廢，附證據）` / `目標不存在（改提新檔或作廢）`.

### Phase 3 — Triage [STOP — user gate]

Present the FULL ledger inline as a table (≤4 columns: id / target / 提案摘要（含出現
次數）/ TL 建議), every row shown including 作廢 ones — the user can override any
default. TL 建議 uses exactly: 🟢 **建議採納**（recurring or clear gap）/ 🟡 **可採納**
（single occurrence, low cost）/ 🔴 **建議作廢／跳過**（stale, duplicate, YAGNI）, each
with a one-line reason. Then ask via AskUserQuestion: 採用 TL 建議 / 自選清單 / 全部
跳過. Wait for the user.

### Phase 4 — Apply

For each adopted row: edit the target per its sketch — anchor placement and exact
wording are decided NOW, at apply time. Group edits per file: one coherent edit beats N
stacked appends. When a structural statement changes (new skill, new flow), also update
the matching `AGENTS.md` / `.claude/rules/*.md` entry per the Self-Improvement rule in
`.claude/rules/global.md`.

### Phase 5 — Verify & report

Re-read each changed file to confirm the edit reads coherently against surrounding
rules (no contradictions, no duplicates). Present `git diff --stat` plus tables:
已套用 / 已作廢 / 已跳過, and one prose paragraph summarizing what the next run
inherits.

### Phase 6 — Clear reports [STOP — user gate]

- A report is **consumed** when every one of its proposals is resolved
  (applied / rejected / 作廢). List consumed vs kept reports, then ask explicitly:
  「刪除已消化的 N 份報告？」. Delete (`rm`) only on yes.
- A report with deferred items stays; update its decided L# lines to
  `status=applied` / `status=rejected:<reason>` in place so the next `/distill` doesn't
  re-litigate them.
- Finally ask about committing the distill change set (edited rules + deleted reports)
  — suggest `chore(distill): fold retro reports into rules`.
