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

### Boolean Convention

- All boolean-like fields in API payloads, KV storage, and encrypted data **must** use the `BoolFlag` enum, never `true | false` or raw `0 | 1` literals.
- `BoolFlag` is defined in both `extension/src/api/client.ts` and `pwa/src/api/client.ts`:
  ```typescript
  export enum BoolFlag {
    FALSE = 0,
    TRUE = 1,
  }
  ```
- This applies to: `isShared`, `isArchived`, `syncArchived`, and any future boolean flags.
- Type definitions: use `BoolFlag` (not `boolean` or `0 | 1`).
- Comparisons: use `=== BoolFlag.TRUE` or `=== BoolFlag.FALSE`.
- Toggle pattern: `value === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE`.
- Why: `true === 1` is `false` in JavaScript strict equality, causing cross-platform bugs between Extension and PWA.

### Decision Framework

Testability > Readability > Simplicity > Consistency > Performance > Maintainability
