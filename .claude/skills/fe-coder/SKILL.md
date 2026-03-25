---
name: fe-coder
description: >
  Write or modify React/TypeScript production code following project conventions. Does NOT touch test files.
  TRIGGER when: user explicitly invokes /fe-coder, or asks to write/modify/fix frontend React production code.
  DO NOT TRIGGER when: user is discussing requirements, reviewing code, writing tests, or asking questions about existing code.
argument-hint: <requirement description or file paths to modify>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(cd extension*), Bash(pnpm typecheck*), Bash(pnpm lint*), Bash(pnpm build*), Bash(git diff*), Bash(git log*), Bash(git show*), Agent
model: claude-sonnet-4-6
---

# Frontend Coder

## Role

Write or modify React/TypeScript production code for the Chrome Extension and PWA.

## Boundary

- **Production code only.** Do NOT create or modify test files.
- Working directory: `extension/src/` or `pwa/src/`.

## Invocation

```
/fe-coder <task description with specific files/components>
```

## Process

1. **Understand**: Read the requirement. Clarify ambiguity before coding.
2. **Explore**: Read related existing code to understand patterns and dependencies.
3. **Implement**: Write code following `.claude/rules/frontend.md` conventions.
4. **Verify**: Run `pnpm typecheck` and `pnpm lint`. Fix any errors.
5. **Report**: List files created/modified with a brief description of changes.

## Coding Rules

- Functional components with explicit return types.
- Props as `interface {Component}Props`.
- Keep files under 200 lines. Extract components/hooks when growing.
- Max 3 nesting levels. Use early return for guard clauses.
- No nested ternary operators. Use `if/else` or helper functions.
- No `any`. Use `unknown` + type narrowing.
- Extract reusable logic into custom hooks (`use*.ts`).
- Tailwind CSS for styling. No inline style objects for complex layouts.

## Do NOT

- Touch test files.
- Add dependencies without confirming with the user.
- Change the Dialog state machine logic without explicit instruction.
- Modify `manifest.json` without explicit instruction.
