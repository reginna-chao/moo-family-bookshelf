## Testing Rules

### Framework & Tools

| Tool                  | Scope              | Purpose                         |
| --------------------- | ------------------ | ------------------------------- |
| Vitest                | Extension + Worker | Unit & integration tests        |
| React Testing Library | Extension          | Component tests                 |
| Playwright            | Extension          | E2E tests with loaded Extension |
| Miniflare             | Worker             | Local KV simulation             |

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

| Scope                   | Target |
| ----------------------- | ------ |
| `extension/src/api/`    | >= 80% |
| `extension/src/dialog/` | >= 70% |
| `worker/src/`           | >= 80% |
| Overall                 | >= 70% |

### Naming

- Test files: `{source}.test.ts` or `{source}.test.tsx`
- E2E files: `{feature}.spec.ts`
- Describe blocks: function/component name
- It blocks: describe expected behavior in English

### Mock Policy

- **Mock**: external API calls, `chrome.storage`, `fetch` to Worker.
- **Do NOT mock**: React hooks, internal utility functions, KV in integration tests (use Miniflare).

### Anti-Drift Rules

- **Import from production code**: E2E test helpers must import constants and key-building functions (e.g., `namespacedKey`, `USER_ID_KEY`) from production source instead of duplicating them. This ensures tests break at compile time when production code changes, rather than silently drifting.
- **User-visible copy needs a production-anchored assertion**: every user-facing string under test must have at least one assertion that hits the production throw/render site. A component test that constructs its own mock error/string and asserts on it verifies nothing — production copy can change while the test stays green. When the string is not exported, one unit test pins the production literal and the component test's mock carries a sync comment pointing at it.
- **Blocking UI checklist**: When adding a modal, overlay, dialog, or any `fixed`/`z-*` element that covers the viewport, verify that E2E test helpers dismiss or skip it. Full-screen overlays block all Playwright `.click()` calls and cause silent timeout failures.
- **E2E must run in CI**: E2E jobs must not be disabled (`if: false`) for more than one release cycle. If a job is temporarily skipped, create a tracking issue.
