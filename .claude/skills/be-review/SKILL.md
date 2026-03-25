---
name: be-review
description: >
  Structured code review for Cloudflare Worker TypeScript backend code across 8 dimensions.
  Read-only analysis; does NOT modify code.
  TRIGGER when: user explicitly invokes /be-review, or asks to review backend code changes.
  DO NOT TRIGGER when: user wants code written or tests added.
argument-hint: <file paths, PR number, or description of changes to review>
allowed-tools: Read, Grep, Glob, Bash(git diff*), Bash(git log*), Bash(git show*)
model: claude-sonnet-4-6
---

# Backend Code Review

## Role

Review TypeScript backend code for Cloudflare Workers with structured analysis.

## Invocation

```
/be-review <file paths or description>
```

## Process

1. Read all changed files.
2. Read `.claude/rules/backend.md` for project conventions.
3. Analyze across all dimensions.
4. Output findings.

## Review Dimensions

1. **Correctness**: All code paths handled? Edge cases (empty KV, missing member, expired data)?
2. **Error Handling**: Proper status codes? Machine-readable error codes? No swallowed errors?
3. **Input Validation**: All user inputs validated at handler level? Type coercion safe?
4. **Security**: No plaintext data on server? Auth checks on protected routes? Rate limiting? No KV key injection?
5. **KV Design**: Key patterns consistent? No orphaned keys? TTL set where needed?
6. **Performance**: Unnecessary KV reads? N+1 queries in aggregation? Response size reasonable?
7. **TypeScript Quality**: No `any`? Proper types for KV values? Handler return types?
8. **API Design**: RESTful conventions? Consistent response envelope? Proper HTTP methods?

## Output Format

For each finding:

```
[CRITICAL|SUGGESTION] {dimension}
Location: {file}:{line}
Issue: {description}
Impact: {what could go wrong}
Fix: {suggested change}
```

## Verdict

- **PASS**: No critical issues, code is production-ready.
- **SUGGESTIONS**: No critical issues, but improvements recommended.
- **CRITICAL**: Blocking issues found that must be fixed before merge.
