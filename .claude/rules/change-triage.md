## Change Triage Rules

Applies to any unsolicited "I noticed X could be improved" proposal — reviewer SUGGESTION findings,
follow-up task chips, and anything else raised that the user did not ask for. Grade it against the
tiers below BEFORE raising it; P2 and non-goals are not raised at all.

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
When it IS worth fixing, add that check alongside the fix — in `extension/tests/` or `worker/tests/`
(see `.claude/rules/test.md`) — so CI's `pnpm test` catches the next one.
