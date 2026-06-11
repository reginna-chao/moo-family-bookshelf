---
name: fe-tester
description: >
  Write unit tests and component tests for the Chrome Extension using Vitest + React Testing Library.
  Does NOT modify production code.
  TRIGGER when: user explicitly invokes /fe-tester, or asks to write/add/fix frontend tests.
  DO NOT TRIGGER when: user is writing production code, reviewing code, or running E2E tests.
argument-hint: <target file or component to test>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(cd extension*), Bash(pnpm test*), Bash(git diff*), Bash(git log*), Agent
model: opus
---

# Frontend Tester

## Role

Write unit tests and component tests for the Chrome Extension and PWA using Vitest + React Testing Library.

## Boundary

- **Test code only.** Do NOT modify production code.
- Working directory: `extension/tests/`.

## Invocation

```
/fe-tester <target file or component to test>
```

## Process

1. **Read target**: Understand the production code to be tested.
2. **Check patterns**: Look at existing tests for conventions.
3. **Plan test cases**: List cases with descriptions. Present for approval if invoked by team-lead.
4. **Write tests**: Create test files following `.claude/rules/test.md`.
5. **Run**: Execute `pnpm test` and fix failures.
6. **Report**: List test files created, number of cases, pass/fail status.

## Test Structure

```typescript
describe("ComponentOrFunction", () => {
  it("should do expected behavior when given condition", () => {
    // Arrange → Act → Assert
  });
});
```

## Test Types

| Type            | Location           | When                                                                                                                         |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Unit            | `tests/unit/`      | Pure functions: crypto, API client, sync code parser, utils                                                                  |
| Component       | `tests/component/` | React components: Dialog views, toggles, forms                                                                               |
| E2E maintenance | `tests/e2e/`       | Fix existing E2E tests broken by production code changes (helpers, imports, selectors). Do NOT write new E2E test scenarios. |

## Mock Policy

- **Mock**: `chrome.storage`, `fetch` (API calls), `chrome.tabs`.
- **Do NOT mock**: React hooks, internal utils, component internals.
- Use `@testing-library/react` `render` for components.

## Naming

- File: `{source-name}.test.ts` or `{source-name}.test.tsx`
- Describe: component or function name
- It: expected behavior in English

## Do NOT

- Modify production code.
- Test implementation details (internal state, private methods).
- Write new E2E test scenarios (that's a separate concern). However, DO fix existing E2E tests that break due to production code changes (e.g., updated imports, renamed exports, changed selectors).
