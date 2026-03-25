## Testing Rules

### Framework & Tools

| Tool | Scope | Purpose |
|------|-------|---------|
| Vitest | Extension + Worker | Unit & integration tests |
| React Testing Library | Extension | Component tests |
| Playwright | Extension | E2E tests with loaded Extension |
| Miniflare | Worker | Local KV simulation |

### Test Locations

- Extension: `extension/tests/{unit,component,e2e}/`
- Worker: `worker/tests/{unit,integration}/`

### Conventions

- Test business behavior, not implementation details.
- Table-driven tests preferred for functions with multiple input scenarios.
- Tests must clean up state (no leaked timers, mocks, listeners, KV entries).
- Integration tests use Miniflare — never connect to real Cloudflare in tests.
- E2E tests load the built Extension into Chrome via Playwright.

### Coverage Targets

| Scope | Target |
|-------|--------|
| `extension/src/crypto/` | >= 90% |
| `extension/src/api/` | >= 80% |
| `extension/src/dialog/` | >= 70% |
| `worker/src/` | >= 80% |
| Overall | >= 70% |

### Naming

- Test files: `{source}.test.ts` or `{source}.test.tsx`
- E2E files: `{feature}.spec.ts`
- Describe blocks: function/component name
- It blocks: describe expected behavior in English

### Mock Policy

- **Mock**: external API calls, `chrome.storage`, `fetch` to Worker.
- **Do NOT mock**: React hooks, internal utility functions, KV in integration tests (use Miniflare).
