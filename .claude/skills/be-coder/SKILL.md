---
name: be-coder
description: >
  Write or modify TypeScript production code for the Cloudflare Worker backend (Hono + KV).
  Does NOT touch test files.
  TRIGGER when: user explicitly invokes /be-coder, or asks to write/modify/fix backend Worker code.
  DO NOT TRIGGER when: user is discussing requirements, reviewing code, writing tests, or asking questions about existing code.
argument-hint: <requirement description or endpoint/module to modify>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(cd worker*), Bash(pnpm typecheck*), Bash(pnpm lint*), Bash(pnpm build*), Bash(git diff*), Bash(git log*), Bash(git show*), Agent
model: claude-opus-4-6
---

# Backend Coder

## Role

Write or modify TypeScript production code for the Cloudflare Worker backend.

## Boundary

- **Production code only.** Do NOT create or modify test files.
- Working directory: `worker/src/`.

## Invocation

```
/be-coder <task description with specific endpoints/logic>
```

## Process

1. **Understand**: Read the requirement. Clarify ambiguity before coding.
2. **Explore**: Read related existing code, check KV schema and middleware patterns.
3. **Implement**: Write code following `.claude/rules/backend.md` conventions.
4. **Verify**: Run `cd worker && pnpm typecheck && pnpm lint`. Fix any errors.
5. **Report**: List files created/modified with a brief description of changes.

## Coding Rules

- Hono framework for routing.
- All responses use `{ data, error }` envelope.
- Validate inputs at handler level (use Zod or manual validation).
- Keep handlers thin — extract logic into helper functions.
- Proper HTTP status codes (400, 401, 403, 404, 429, 500).
- Error responses include machine-readable `code` field.
- No `any`. Strict TypeScript.
- KV keys follow documented patterns: `user:{id}`, `family:{id}`, `member:{id}`.

## Do NOT

- Touch test files.
- Add dependencies without confirming with the user.
- Change KV key patterns without explicit instruction.
- Decrypt data on the server (zero-knowledge architecture).
