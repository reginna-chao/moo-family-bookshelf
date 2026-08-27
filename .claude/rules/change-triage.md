## Change Triage Rules

Applies to any unsolicited "I noticed X could be improved" proposal — reviewer SUGGESTION findings,
follow-up items surfaced mid-run, and anything else raised that the user did not ask for. Grade it
against the tiers below BEFORE raising it; P2 and non-goals are not raised at all.

### Tiers (graded by the consequence of NOT fixing it)

- **P0 — ships broken.**
  Privacy leak or data disclosure; violation of any invariant in `.claude/rules/security-ux-invariants.md`;
  a book shared without explicit opt-in; auth-token or permission bypass; unrecoverable state left
  behind on an error path.

- **P1 — another surface trips over it.**
  Contract drift between Extension / PWA / Worker (payload shape, error `code`, `BoolFlag` handling);
  logic that belongs in `shared/` written separately on each side, so the two ends can diverge;
  anything that turns CI red (`pnpm lint` / `pnpm typecheck` / `pnpm test`).

- **P2 — only affects development.**
  DX, refactoring, readability, naming preference. Not done by default unless explicitly requested.

### Non-goals (do not propose, even when technically correct)

- A new abstraction layer or component wrapper, unless the same pattern already repeats 3+ times.
  Distinct from `.claude/agents/reviewer.md`'s "extract duplication (2+ occurrences)": that threshold
  covers pulling out code that is ALREADY duplicated; this one covers introducing a NEW abstraction.
- New build steps, new dependencies, new toolchains.
- Hashed filenames, View Transitions, changes to the output file layout.
- Runtime JS added to solve what CSS already solves.
- Micro-optimizations without measured evidence.
- Comments, type annotations, or anything `pnpm lint` / `pnpm format` / `pnpm typecheck` already covers.

### Every proposal must carry

1. An exact location (`file:line`). If you cannot give one, do not raise it.
2. The tier (P0 / P1) and the concrete consequence of leaving it unfixed.
3. Whether a check that fails on it today can be written.

Item 3 is the gate: if no failing check can be written, it is usually taste rather than a defect.
When it IS worth fixing, add that check alongside the fix — in `extension/tests/`, `pwa/tests/`, or
`worker/tests/` (see `.claude/rules/test.md`) — so CI's `pnpm test` catches the next one.

### Disposition of out-of-scope P0/P1

A P0/P1 discovered during a run that does NOT belong to the current task is **recorded as a GitHub
issue** — `gh issue create`. Never open a worktree for it, never spawn a follow-up task chip
(`spawn_task`), never widen the current run's scope to absorb it.

**Who runs `gh issue create`.** ONLY the session that owns the run — the `/develop` orchestrator, or
the main assistant session when working outside `/develop`. A dispatched agent (`reviewer`, `coder`,
`tester`) NEVER creates the issue itself, even when its toolset includes Bash: it surfaces the item
in its structured return and the owning session records it. Otherwise one finding read by both the
agent and the orchestrator lands as two duplicate issues.

- **Issue body** carries, explicitly: the tier (P0 / P1), the exact `file:line`, the concrete
  consequence of leaving it unfixed, and whether a failing check can be written — the same three
  items required of any proposal above.
- **Label** the issue with its tier: `P0` or `P1`. Labeling is **best-effort** — if attaching the label fails (the label does not exist in the repo, or `gh` rejects it), still create the issue and prefix its title with `[P0]` / `[P1]` so the tier survives in plain text.
- **Title** in English, imperative form — same convention as commit messages
  (e.g. `Fix stale status timer left running after unmount`).
- **P2 and non-goals** are, as before, not raised anywhere at all — no issue, no passing mention.
- **Worktrees are reserved exclusively for tasks the user explicitly starts.** A finding is never a
  reason to create one.
- `gh` in this repo runs under the personal account via `GH_CONFIG_DIR`, configured in
  `.claude/settings.local.json` (gitignored, per-developer). If `gh` is unavailable in a session **or
  issue creation itself fails** (auth, network, rate limit), list the item in that run's final report
  instead — never drop it silently, and never fall back to a worktree or a task chip.
