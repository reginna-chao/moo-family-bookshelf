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

| Intent | Signals | Route |
| --- | --- | --- |
| **CODE** | implement / add / fix / refactor / build / test / review a feature; anything touching `extension/` `pwa/` `worker/` source | → load `references/code-cycle.md`, run that lifecycle |
| **DESIGN** | "make a favicon / logo / app icon / OG image / banner"; "design a brand"; "I don't like the colors / want to explore visual direction" | → load `references/design.md`, run that orchestration |
| **MIXED** | a code feature that also needs a new screen's visual mockup | → run the CODE lifecycle; it dispatches the `designer` agent inline at the Phase-1 mockup gate |

If genuinely ambiguous, ask ONE clarifying question (AskUserQuestion) before loading a reference. When the route is clear, **`Read` the matching reference file and follow it** — it carries the full phase-by-phase workflow.

## §1 Hard rules (both routes)

- **Never write code or design assets directly.** Dispatch agents.
- **Code Modification Workflow is mandatory** (`.claude/rules/global.md`): every code change — regardless of size — goes through coder → typecheck → tester → review → fix. "Too small" is never a reason to skip. Only the user explicitly saying "skip review" / "just write the code" bypasses it, for that task only.
- **Scope tagging.** Every code work-item is `frontend` or `backend`. When dispatching a `coder` / `tester` / `reviewer` agent, pass `scope` so it reads the right rules (`frontend.md` / `backend.md`) and runs the right commands. A full-stack feature splits into separate scoped dispatches.
- **Agents dispatched via the Agent tool are non-interactive** — they cannot pause for the user. YOU hold every user gate (requirements confirm, verify-before-test, SUGGESTION decisions, commit) in this session. Do not push a user gate into an agent prompt.
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

## §3 Agent dispatch quick-reference

| Agent | Use for | Key inputs |
| --- | --- | --- |
| `coder` | production code | `scope`, `requirements`, `files`, `mode` (production/research-only) |
| `tester` | tests | `scope`, `target`, `scope_intent`, `change_summary` (+ actual diff) |
| `reviewer` | code review | `scope`, `target`, `business_logic` |
| `security-auditor` | post-feature security scan | `scope` (full/secrets/deps/code/extension/crypto/api/publish) |
| `designer` | UI mockup or brand/SVG asset | `request`, `context` |

Parallelize across file-disjoint scopes (frontend + backend coders run concurrently); never let two concurrent agents own the same file. Re-review only the files changed by a fix, unless the user asks for a full re-review.

## §4 References

- `references/code-cycle.md` — the CODE lifecycle: requirements + risk analysis → API contract → coder → verify-before-test gate → tester → review → Fix Cycle (CRITICAL auto-fix / SUGGESTION decision with 🟢🟡🔴 TL 建議) → cross-scope validation → security scan → commit.
- `references/design.md` — the DESIGN orchestration: triage (brand assets / add icon / style consultation) → brief → dispatch `designer` → Review & Deliver (integration snippets) → commit.

Read the one the §0 fork selected. Do not preload both.
