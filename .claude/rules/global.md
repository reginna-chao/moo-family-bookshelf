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

### Decision Framework

Testability > Readability > Simplicity > Consistency > Performance > Maintainability
