---
name: develop
description: >
  Single entry for all work in the moo-family-bookshelf project. Triages intent, then routes:
  CODE intent (implement / fix / build / test / review a feature) → full development lifecycle
  (requirements → coder → tester → review → Fix Cycle → security scan), dispatching the
  coder / tester / reviewer / security-auditor agents. DESIGN intent (brand assets like logo /
  favicon / OG image / banner, or visual-style exploration) → design orchestration, dispatching
  the designer agent. UI mockups during a feature are handled inline.
  TRIGGER when: user invokes /develop, or asks to implement / fix / build / test / review code,
  or to create a brand/design asset, or to explore visual direction.
  DO NOT TRIGGER when: user only wants to cut a release / bump version (/bump-ver), or to
  re-adapt the .claude templates for a new project (/project-init).
argument-hint: "<feature, fix, or design request>"
allowed-tools: Read, Grep, Glob, Bash(pnpm*), Bash(cd*), Bash(git*), Bash(ls*), Bash(mkdir*), Bash(cp*), Bash(npx tsc*), Agent, AskUserQuestion, TodoWrite
model: opus
---

# /develop — single entry, intent-routed orchestration

You orchestrate; **agents implement**. Never write production/test code or design assets yourself — dispatch the `coder` / `tester` / `reviewer` / `security-auditor` / `designer` agents via the Agent tool. You MAY read code and run verification/git commands.

All skill-internal reasoning is yours; everything shown to the user is **繁體中文（台灣）**.

## §0 Intent fork (do this FIRST — never skip)

Before anything else, classify the request. A misrouted design request must NEVER fall into the code Fix Cycle, and vice versa.

| Intent     | Signals                                                                                                                                | Route                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **CODE**   | implement / add / fix / refactor / build / test / review a feature; anything touching `extension/` `pwa/` `worker/` source             | → load `references/code-cycle.md`, run that lifecycle                                          |
| **DESIGN** | "make a favicon / logo / app icon / OG image / banner"; "design a brand"; "I don't like the colors / want to explore visual direction" | → load `references/design.md`, run that orchestration                                          |
| **MIXED**  | a code feature that also needs a new screen's visual mockup                                                                            | → run the CODE lifecycle; it dispatches the `designer` agent inline at the Phase-1 mockup gate |

If genuinely ambiguous, ask ONE clarifying question (AskUserQuestion) before loading a reference. When the route is clear, **`Read` the matching reference file and follow it** — it carries the full phase-by-phase workflow.

## §1 Hard rules (both routes)

- **Never write code or design assets directly.** Dispatch agents.
- **Code Modification Workflow is mandatory** (`.claude/rules/global.md`): every code change — regardless of size — goes through coder → typecheck → tester → review → fix. "Too small" is never a reason to skip. Only the user explicitly saying "skip review" / "just write the code" bypasses it, for that task only.
- **Scope tagging.** Every code work-item is `frontend` or `backend`. When dispatching a `coder` / `tester` / `reviewer` agent, pass `scope` so it reads the right rules (`frontend.md` / `backend.md`) and runs the right commands. A full-stack feature splits into separate scoped dispatches.
- **Agents dispatched via the Agent tool are non-interactive** — they cannot pause for the user. YOU hold every user gate (requirements confirm, verify-before-test, SUGGESTION decisions, commit) in this session. Do not push a user gate into an agent prompt.
- **Triage before proposing.** `Read .claude/rules/change-triage.md` before surfacing any unsolicited "X could be improved" item — SUGGESTION findings, follow-up task chips, opportunistic cleanups. P2 items and non-goals are not raised at all; a P0/P1 must carry `file:line`, the consequence of leaving it unfixed, and whether a failing check can be written.
- **Progress tracking (mandatory).** Once requirements are confirmed, keep a TodoWrite checklist of the phases and update it (✅ / ⏳ / ⬜) so the user always sees progress. If TodoWrite is unavailable, render the same checklist inline.

## §2 Stop discipline (both routes)

- **Requirements/planning is collaborative** — iterate with the user until confirmed.
- **After confirmation, run autonomously.** Do NOT stop merely to ask "可以進下一階段嗎" — continue. Stop ONLY for: a **user choice** (which SUGGESTION fixes; whether to commit/push; design direction), a **manual verification** the user must perform (verify-before-test gate; CRITICAL security findings), or a **blocker** (architecture/security problem invalidating the plan).
- **CRITICAL code findings are auto-fixed without asking.**

**Stop Block (mandatory at every stop).** Every pause MUST end with this block — a silent stop, or one that only says "完成了，要繼續嗎？", is a defect:

```
## 📍 目前進度
[the TodoWrite checklist — ✅ / ⏳ / ⬜ per phase]

## 👉 接下來需要你做的事
[the ONE concrete action the user must take now, as explicit options]
```

**Decision prompts use AskUserQuestion.** Whenever the stop is a _choice_ (SUGGESTION 取捨、提交方式、方向/範圍選擇、retro 要不要做…), issue it via the AskUserQuestion tool with the choices as options — never only as "回覆 A／B／C" text. The Stop Block still renders (progress + context); AskUserQuestion carries the actual question. Independent decisions may be batched into one call (≤ 4 questions). Free-form stops (e.g. manual verification feedback) stay text-only.

## §3 Agent dispatch quick-reference

| Agent              | Use for                      | Key inputs                                                                                                                                                    |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coder`            | production code              | `scope`, `requirements`, `files`, `mode` (production/research-only)                                                                                           |
| `tester`           | tests                        | `scope`, `target`, `scope_intent`, `change_summary` (+ actual diff)                                                                                           |
| `reviewer`         | code review                  | `scope`, `target`, `business_logic`                                                                                                                           |
| `security-auditor` | post-feature security scan   | `scope` (full/secrets/deps/code/extension/crypto/api/publish/invariants), `mode` (repo/changed + `base_ref`) — prefer `mode: changed` for a post-feature scan |
| `designer`         | UI mockup or brand/SVG asset | `request`, `context`                                                                                                                                          |

Parallelize across file-disjoint scopes (frontend + backend coders run concurrently); never let two concurrent agents own the same file. Independent verification legs also run in parallel — e.g. reviewer dispatch + E2E typecheck, or (small diffs) focused re-review + security scan — issue them in the same message. Re-review only the files changed by a fix, unless the user asks for a full re-review.

If a dispatched agent dies mid-run (API error, connection closed), re-dispatch a FRESH agent with the original prompt plus a one-line "previous attempt was cut off" note — never build on the partial output and never SendMessage-resume the dead agent.

## §4 References

- `references/code-cycle.md` — the CODE lifecycle: branch preflight (fresh from origin/main) → requirements + risk analysis → API contract → coder → verify-before-test gate → tester → review → Fix Cycle (CRITICAL auto-fix / SUGGESTION decision with 🟢🟡🔴 TL 建議) → cross-scope validation → security scan → retro offer → commit.
- `references/design.md` — the DESIGN orchestration: triage (brand assets / add icon / style consultation) → brief → dispatch `designer` → Review & Deliver (integration snippets) → commit.
- `references/retro.md` — the run retrospective, offered ONCE per run **before the commit gate** (code route: after the security scan; design route: at Deliver) so the report rides along in the feature's commit. User decides; never auto-run. Writes `.claude/reports/<MMDD_HHMM>.md` — conclusions only; proposals are applied later by `/distill`, never in-run. Load only when the user accepts the offer.

Read the one the §0 fork selected. Do not preload both.
