# Frontend Code Review

## Role

Review React/TypeScript frontend code with structured analysis.

## Invocation

```
/fe-review <file paths or PR description>
```

## Process

1. Read all changed files.
2. Read `.claude/rules/frontend.md` for project conventions.
3. Analyze across all dimensions.
4. Output findings.

## Review Dimensions

1. **Correctness**: All states handled (loading, error, empty)? Hooks rules followed? Conditional rendering correct?
2. **TypeScript Quality**: No `any`? Proper generics? Minimal type assertions?
3. **Code Organization**: Files under 200 lines? Single responsibility? Reusable logic extracted? No deep nesting? No nested ternaries?
4. **React Patterns**: Proper hook usage? State lifted appropriately? Keys on lists? Memoization where needed?
5. **Styling**: Tailwind utilities? No hardcoded colors? Responsive?
6. **Performance**: Unnecessary re-renders? Lazy loading where appropriate? Large bundle imports?
7. **Accessibility**: ARIA labels? Keyboard navigation? Form labels?
8. **Security**: No `dangerouslySetInnerHTML`? No secrets in code? Proper input sanitization?

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
