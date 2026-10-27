# Vendored: Elephant-Goldfish Model (EGM) — reviewer personas

- Upstream: https://github.com/google/elephant-goldfish-model
- Author: Google LLC — Apache License 2.0 (see `LICENSE`, kept verbatim)
- Upstream commit: `b3a35956759bf7f024af2ff061b2e0b44b438e4c` (2026-10-26)
- Vendored on: 2026-10-27

## What is included

`../goldfish.md` is an ADAPTATION, not a copy: it folds three upstream reviewer personas —
`agents/implementation_readiness.md`, `agents/codebase_details.md`, `agents/design_critic.md` — and
the quality bar of `resources/document_standards/implementation-readiness-standard.md` into one
agent selected by a `persona` input, in this project's agent format. Dropped: the BRAINSTORM mode of
each persona, the `zoom_out` / `comprehension` / `structural` / `style` personas, the five-stage
review pipeline (`skills/egm_review`), the `synthesizer` and `bootstrap` orchestrators, and the
`egm-*` skills. Nothing under `skills/` or `resources/` is copied.

## Why an adaptation instead of the plugin

The upstream skills carry `disable-model-invocation: true` and are started by a human typing
`/egm:…`. This project routes every change through `/develop` and wants the goldfish review to run
automatically inside it, between the execution plan and the GO gate, with no second entry point —
so the review step lives in `.claude/skills/develop/references/code-cycle.md` and only the reviewer
persona is taken from upstream. The five-stage pipeline was judged too expensive for a one-developer
project on a per-token budget; the two personas that catch what the project's own reviewer cannot
(a plan that leaves decisions to the coder, a plan that contradicts the code) were kept.

## How this project uses it

- Dispatched ONLY by `/develop`, full cycle only, never in fix mode or the bug fast-path.
- Requires Claude Code 2.1.271 or later: `omitClaudeMd` is ignored silently by older versions and
  the review then runs with `CLAUDE.md` loaded. Every goldfish report opens with a `rules seen`
  field (`goldfish.md` → Output format), so the orchestrator sees on each run whether the isolation
  held. A path-scoped rule matching a file the goldfish read (`frontend.md`, `backend.md`,
  `test.md`) is expected there; `CLAUDE.md`, `AGENTS.md` or a rule without `paths` can only have
  loaded at startup, and on a current Claude Code that is a bug to investigate, not a residual.
- `omitClaudeMd: true` and `tools: Read, Glob, Grep` — the reviewer sees the `PLAN.md` draft and the
  files it names, nothing from the conversation and nothing from the startup `CLAUDE.md` /
  `AGENTS.md`. That isolation is the whole point: a review in the same context is not a goldfish
  review. It is NOT isolation from the repository's conventions: `omitClaudeMd` skips only what
  loads at startup, so a path-scoped `.claude/rules/*.md` (`frontend.md`, `backend.md`, `test.md`)
  still loads when the reviewer opens a matching source file. `goldfish.md` tells it to treat such a
  file as a convention check, never as context that fills a gap in the plan.
- The Elephant (the `/develop` orchestrator) classifies each finding with upstream `egm-resolve`'s
  four categories (PROPOSE FIX / ESCALATE / DECLINE / CONTEST) and shows the user three lights
  (🟢 建議修 / 🟡 可修可不修 / 🔴 不成立). The rules "a contest must be checkable", "never change a
  severity" and "never contest a comprehension gap" are upstream's and are kept.
