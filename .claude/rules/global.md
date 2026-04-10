## Global Development Rules

### Language

- Code identifiers, commit messages, branch names: English.
- User-facing content (UI, docs, comments in docs): 繁體中文.
- Code comments: English for technical, 繁體中文 acceptable for business logic explanations.

### Git Hygiene

- Always `git add` new files before committing (except `.env`, `.dev.vars`, secrets).
- Follow conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Run `pnpm lint` and `pnpm test` before pushing.

### Self-Improvement

- When file architecture changes, update corresponding `.claude/rules/*.md` to reflect new structure.
- When adding new patterns or conventions, update `AGENTS.md` accordingly.

### File References

- Always use repo-root relative paths (e.g., `extension/src/dialog/FamilyShelf.tsx:42`).
- Never use absolute paths in chat or documentation.

### Code Quality

#### Architecture

- Single Responsibility: each function, module, and class does one thing. If a name needs "and" to describe it, split it.
- Explicit layering: separate entry points (handlers, controllers, event listeners) from business logic from data access. Do not mix concerns in a single function.
- Depend on abstractions, not concretions. When a module directly depends on a specific external service, isolate that dependency behind an interface or adapter.
- Prefer composition over inheritance.
- No god functions: if a function exceeds ~40 lines, it is likely doing too much. Extract sub-steps.

#### Performance

- No redundant I/O: never read the same data source (DB, API, file) multiple times in a single request/operation when one read suffices.
- Batch over loop: when accessing external resources inside a loop, batch them into a single operation. Avoid N+1 patterns.
- No unnecessary recomputation: if a value is expensive to compute and used more than once, compute it once and reuse.
- Measure before optimizing: do not add caching, memoization, or complexity for performance unless there is evidence of a bottleneck.

#### Side Effects

- Side effects must be explicit and centralized. A function that modifies external state should make that obvious from its name and signature.
- Entry in, cleanup out: every side effect that acquires a resource (listener, timer, connection, subscription) must have a corresponding cleanup path.
- No hidden state mutation: middleware, decorators, and utility functions must not silently modify shared state.
- Isolate impure code: push side effects to the edges of the system. Keep core business logic pure.
- Error paths must also clean up: if a function fails partway through, any side effects already performed must be rolled back or cleaned up.

#### Data Access

- Define a clear data access layer. Application logic should not contain raw queries or direct storage API calls scattered throughout.
- Validate at system boundaries: validate all external input at the point of entry. Internal code can trust validated data.
- Do not over-fetch: request only the data you need.

### Decision Framework

Testability > Readability > Simplicity > Consistency > Performance > Maintainability

### Code Modification Workflow (Mandatory)

Any code modification — **regardless of size** — must go through the full cycle:

1. **Write** (coder) → 2. **Typecheck** → 3. **Test** (tester, where applicable) → 4. **Review** (review skill) → 5. **Fix cycle** for any CRITICAL findings → 6. **Report** to user

"Size too small" is NEVER a valid reason to skip review. A one-line fix is subject to the same cycle as a 500-line feature. The cost of an extra review round is trivial; the cost of silently shipping unreviewed code is not.

**Only exceptions:**
- Pure typo fixes in user-facing strings (note: these may still break tests and should be verified).
- Pure comment / doc changes that touch no executable code.
- The user explicitly authorizes bypass for a specific task with a phrase such as "skip review", "just write the code", or "no need for the full workflow". Absent such explicit instruction, the cycle is mandatory.

**Enforcement routes:**
- `/team-lead` orchestrates `/fe-team-lead` and `/be-team-lead`, which in turn run `coder → tester → review → fix` inside their Fix Cycle.
- Invoking `fe-coder`, `be-coder`, `fe-tester`, `be-tester`, `fe-review`, or `be-review` **directly from team-lead** bypasses the Fix Cycle and is prohibited.
- When the user invokes a lower-level skill like `/fe-coder` directly, follow that skill's own scope — but still run `pnpm typecheck` and report any lint/type issues before finishing.

**Self-check before the final report:** ask yourself "did I skip review because the change was small?" If yes, go back and run review. No exceptions.
