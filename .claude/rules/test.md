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
- PWA: `pwa/tests/{unit,component,e2e}/`
- Worker: `worker/tests/{unit,integration}/`

### Conventions

- Test business behavior, not implementation details.
- Table-driven tests preferred for functions with multiple input scenarios.
- Tests must clean up state (no leaked timers, mocks, listeners, KV entries).
- Integration tests use Miniflare — never connect to real Cloudflare in tests.
- E2E tests load the built Extension into Chrome via Playwright.
- Single-file runs: `pnpm test -- <path>` does NOT filter in ANY package — the `--` is swallowed and the full suite runs. Use `npx vitest run <path>` from inside `extension/`, `pwa/`, or `worker/`.

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
- **Prod-mode rate-limit tests share the per-IP counter**: `prodRequest` without a `cf-connecting-ip` header lands every case on `ratelimit:unknown:*` — bulk cases isolate with a unique IP per case.
- **KV write-order tripwire exists**: `worker/tests/helpers/kvOps.ts` (`watchKvOps` / `writeTrail()`) — reuse it, don't reinvent.
- **KV mock enforces the TTL floor**: `createMockKV()` (`worker/tests/helpers/mockKv.ts`) throws on `expirationTtl < 60` or a non-integer value, mirroring real Cloudflare KV's minimum (stricter on non-integers, which the platform would truncate). A test that genuinely needs a sub-minimum TTL must build its own stub instead of weakening the shared mock — and such a stub is for KV-behaviour tests only; tests exercising production write paths must keep going through `createMockKV()` so the tripwire stays live.

### Anti-Drift Rules

- **Import from production code**: E2E test helpers must import constants and key-building functions (e.g., `namespacedKey`, `USER_ID_KEY`) from production source instead of duplicating them. This ensures tests break at compile time when production code changes, rather than silently drifting.
- **User-visible copy needs a production-anchored assertion**: every user-facing string under test must have at least one assertion that hits the production throw/render site. A component test that constructs its own mock error/string and asserts on it verifies nothing — production copy can change while the test stays green. When the string is not exported, one unit test pins the production literal and the component test's mock carries a sync comment pointing at it.
- **`findBy*` 不是 effect flush barrier**：RTL 的 `findBy*` 會在停用 act environment 的狀態下等待，並以裸 `setTimeout(0)` 收尾，因此 DOM 節點出現 ≠ passive effect 已 commit。當測試接著要互動、而該互動依賴 passive effect 發布的值（ref、訂閱、timer）時，就緒訊號必須是 `await act(async () => { render(...) })`；只有 act 保證離開時 pending effects 已 flush。CPU 爭用下才會現形，所以本地單跑會綠、全 workspace 併發才 flaky。
- **Guard tests must prove they can fail**: a test pinning a tripwire / guard / cleanup ("X never happens") is validated at authoring time with a one-shot mutation check — temporarily disable the guard (stage the file or work on a copy first), confirm the test goes red, restore and verify by diff — and the run report carries that evidence. A negative assertion additionally needs a positive companion pinning the selector/key prefix it negates, or selector drift lets it pass vacuously.
- **Substring copy variants need exact equality**: when a new user-facing string is a substring/superstring of an existing one, assert with exact equality plus a negative assertion on the sibling variant — a positive substring match stays green after the variant is removed.
- **Cross-package parity tests must be CI-reachable**: check `.github/workflows/cicd.yml` path filters so the change class the test guards actually triggers the job it lives in. A guard that runs on only one side is worse than none.
- **Fake timers exclude RTL waiters**: while `vi` fake timers are installed, `waitFor` / `findBy*` are forbidden — RTL cannot see the fake clock, so the waiter polls a frozen clock until `testTimeout` (the mechanism behind whole-integer 30s timeouts). Tripwire: file-level `afterEach(() => vi.useRealTimers())`.
- **Flake work needs a calibrated baseline**: before fixing, find a load that actually reproduces the failure and record the pre-fix baseline (an uncalibrated all-green proves nothing), and run the whole file and suite to learn whether the named symptom is one instance of a class. Acceptance is repeated full-suite runs — concurrency is the trigger — never a single-file pass. A heavyweight render test whose runtime nears half of `testTimeout` is over budget: shrink the rendered volume (e.g. inject a small `pageSize`), don't raise the global timeout.
- **Blocking UI checklist**: When adding a modal, overlay, dialog, or any `fixed`/`z-*` element that covers the viewport, verify that E2E test helpers dismiss or skip it. Full-screen overlays block all Playwright `.click()` calls and cause silent timeout failures.
- **E2E must run in CI**: E2E jobs must not be disabled (`if: false`) for more than one release cycle. If a job is temporarily skipped, create a tracking issue.
