---
paths:
  - "**/tests/**"
  - "**/*.test.{ts,tsx}"
  - "**/*.spec.ts"
  - "extension/scripts/**"
---

## Testing Rules

### Framework & Tools

| Tool                  | Scope              | Purpose                                                                    |
| --------------------- | ------------------ | -------------------------------------------------------------------------- |
| Vitest                | Extension + Worker | Unit & integration tests                                                   |
| React Testing Library | Extension          | Component tests                                                            |
| Playwright            | Extension          | E2E tests with loaded Extension                                            |
| `createMockKV()`      | Worker             | In-memory KV for unit/integration tests (`worker/tests/helpers/mockKv.ts`) |

### Test Locations

- Extension: `extension/tests/{unit,component,e2e}/`
- PWA: `pwa/tests/{unit,component,e2e}/`
- Worker: `worker/tests/{unit,integration}/`

### Conventions

- Test business behavior, not implementation details.
- Table-driven tests preferred for functions with multiple input scenarios.
- Tests must clean up state (no leaked timers, mocks, listeners, KV entries).
- Worker integration tests call the Hono app in-process — `app.request(path, init, { KV: createMockKV(), … })` — on Vitest's default Node pool. There is no Miniflare / workerd runtime in `pnpm test`: `@cloudflare/vitest-pool-workers` sits in `worker/package.json` but no pool is configured in `worker/vitest.config.ts`. Miniflare only runs behind `wrangler dev` (local dev and the E2E webServer). Never connect to real Cloudflare in tests.
- E2E tests load the built Extension into Chrome via Playwright.
- Single-file runs: `pnpm test -- <path>` does NOT filter in ANY package — the `--` is swallowed and the full suite runs. Use `npx vitest run <path>` from inside `extension/`, `pwa/`, or `worker/`.

### E2E tooling (extension/scripts)

Two Node scripts outside `tests/` feed the Extension E2E suite. Their comments point here; the Chrome / Firefox build scripts are covered in `docs/architecture.md` → 十三、建置與驗證腳本（extension/scripts）.

- **`build-e2e.ts`** (`pnpm build:e2e`, run by CI's `e2e` job): runs `pnpm build`, then patches `dist/manifest.json` IN PLACE, adding `http://localhost:*/*` to every `content_scripts[].matches`, to `host_permissions` (created if absent) and to every `web_accessible_resources[].matches`, so the content script runs on the localhost mock fixture pages. The patch must stay AFTER `pnpm build`: `pnpm build` ends with `verify-build.ts`, which fails on any pattern outside `READMOO_MATCH_PATTERNS` — never add localhost to `public/manifest.json` or to the build itself.
- **`verify-selectors.ts`** (`pnpm e2e:verify:selectors`; `pnpm e2e:verify:selectors:update` adds `--update-mock`): a manual tool, not run in CI. It checks the library and profile selectors (`LIBRARY_SELECTORS` / `ME_SELECTORS`, built from `READMOO_SELECTORS` in `shared/src/config/readmoo.ts`) against the live Readmoo `#/library` and `#/me` pages and replicates the scraper's email heuristic, once per site — `next.readmoo.com` (primary) and the legacy `read.readmoo.com` — with each selector tagged by the site it applies to (`appliesTo`). `readmoo-lend.ts`'s `detailTrigger*` selectors are NOT checked, and `borrowedBadge` is only counted during capture, never part of pass/fail.
  - Browser: headed Chromium via `launchPersistentContext` on a dedicated, gitignored profile `extension/.verify-selectors-profile/`, so your main Chrome profile is never locked. On the first run, log into Readmoo in the opened window; the cookie persists. The library needs at least one book.
  - Waiting (`waitForLibrary`): both sites get 10 s for the library to render; the primary site then waits up to 5 min for a manual login, while the legacy site gives up so a logged-out legacy account cannot stall or fail the run.
  - Exit code (`printFinalSummary`): `1` when the PRIMARY site is unreachable or has a failing required selector, else `0`. Legacy-site problems are warnings only — that host is being retired, and a logged-out / empty legacy account is not a regression in our code.
  - `--update-mock` regenerates the git-tracked `extension/tests/e2e/fixtures/mock-readmoo.html` from the primary site only, and only when every required primary selector passed: up to 5 hovered `.library-item` cards, the nav bar and the `#/me` panel.
- **Fixture sanitizing** (`sanitizeLibraryHtml` in `verify-selectors.ts`) — nothing tied to a purchaser's account may reach the fixture. Order: ids → titles → images → progress bars; ids go FIRST so the id map is built from the original markup.
  - Ids (`sanitizeLibraryIds`): every id in a reader-link href, a `privacy-{id}` element id or a `data-moo-book-id` attribute (stamped by our fiber bridge, present only if the capture ran with the extension loaded) becomes a synthetic 15-digit `2104394680001NN`, numbered in first-appearance order. The same real id always maps to the same synthetic one, so a card's href and `privacy-*` id stay consistent. Suffixes start at `11` (`SYNTHETIC_ID_START`): `01`–`05` are reserved for the guard cards (the legacy guard pins `210439468000105`). A collision would give two cards one bookId, and the sync merge (`extension/src/sync/mergeBooks.ts`, keyed by bookId) would silently collapse the guard.
  - Titles: every `.title` element's `title` attribute and text become `測試書籍 N`. `TITLE_ATTRIBUTE_PATTERN` uses a `(?<![-\w])` lookbehind because `\btitle=` also matches the tail of `data-title=` / `aria-title=` (a word boundary holds after `-`), which would rewrite the wrong attribute and leave the real `title="…"` untouched.
  - Images: every `<img>`'s `src` / `data-src` / `srcset` becomes a placeholder and `alt` becomes `cover` (Readmoo puts the title in `alt`). The `#/me` panel's avatar goes through the same image sanitizer; then the email becomes `test-user@readmoo.com` and the display name `測試使用者`.
  - Reading progress: the inline `style` on `.progress-bar` is dropped.
  - Last line of defence (`reportResidualIds`): any 12+ digit run not starting with the synthetic prefix is reported — Readmoo may now carry the id somewhere `REAL_ID_PATTERN` does not know. Update the pattern and check the fixture by hand before committing.
  - Regenerated titles, covers and ids differ from the committed fixture's fixed ones: check every E2E assertion on a specific title or bookId by hand before committing.
- **Guard cards** — appended to EVERY generated fixture because the new-site capture can never produce them. Keep both; never convert them:
  - `SHORT_ID_GUARD_CARD` (書籍 4, 薩提爾的對話練習 / `privacy-18548672`; markup identical to the committed fixture's card): new-site structure with no `a.reader-link`, so its only id source is the 8-digit internal `privacy-*` id. `bookIdFromPrivacy` (`extension/src/content/scraper-ids.ts`) accepts only 12+ digit ids and skips the book, and `extension/tests/e2e/book-sharing.spec.ts` asserts it never reaches the personal shelf. Never lengthen the id and never add an `a.reader-link`.
  - `LEGACY_GUARD_CARD` (書籍 5, 刻意練習 / `210439468000105`): legacy `read.readmoo.com` `.openbook` structure — the fixture's only coverage of `queryWithLegacyFallback`'s legacy branch. Never convert it to the new-site structure.

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
- **Do NOT mock**: React hooks, internal utility functions.
- **KV goes through the shared mock**: every Worker suite that needs a KV store, unit and integration alike, uses `createMockKV()` (`worker/tests/helpers/mockKv.ts`) as its store — never write a second in-memory KV implementation (the sub-minimum-TTL case below is the one exception). Wrapping it to inject a failure or record operations (`worker/tests/integration/kickedTombstone.test.ts`, `worker/tests/unit/verificationGate.test.ts`) or an always-throwing stub for a KV-outage case is fine — those delegate to or replace the store, they do not re-implement it. So is a stateless double that implements the `KVNamespace` surface with canned results to observe call shape (`ReceiverCheckingKv` in `worker/tests/unit/kvOpCounting.test.ts`): it stores nothing, so there is no second store to drift. The shared mock models a single, instantly consistent store: TTLs are validated and recorded (`getPutTtl`) but never expire, and there is no cross-colo propagation lag. A test that needs "the entry expired" deletes the key itself; a race that depends on stale reads cannot be reproduced here.
- **Prod-mode rate-limit tests share the per-IP counter**: `prodRequest` without a `cf-connecting-ip` header lands every case on `ratelimit:unknown:*` — bulk cases isolate with a unique IP per case.
- **KV write-order tripwire exists**: `worker/tests/helpers/kvOps.ts` (`watchKvOps` / `writeTrail()`) — reuse it, don't reinvent.
- **KV mock enforces the TTL floor**: `createMockKV()` (`worker/tests/helpers/mockKv.ts`) throws on `expirationTtl < 60` or a non-integer value, mirroring real Cloudflare KV's minimum (stricter on non-integers, which the platform would truncate). A test that genuinely needs a sub-minimum TTL must build its own stub instead of weakening the shared mock — and such a stub is for KV-behaviour tests only; tests exercising production write paths must keep going through `createMockKV()` so the tripwire stays live.

### Anti-Drift Rules

- **Import from production code**: E2E test helpers must import constants and key-building functions (e.g., `namespacedKey`, `USER_ID_KEY`) from production source instead of duplicating them. This ensures tests break at compile time when production code changes, rather than silently drifting.
- **User-visible copy needs a production-anchored assertion**: every user-facing string under test must have at least one assertion that hits the production throw/render site. A component test that constructs its own mock error/string and asserts on it verifies nothing — production copy can change while the test stays green. When the string is not exported, one unit test pins the production literal and the component test's mock carries a sync comment pointing at it.
- **`findBy*` is NOT an effect-flush barrier**: RTL's `findBy*` waits with the act environment disabled and finishes on a bare `setTimeout(0)`, so a DOM node appearing does NOT mean the passive effects have committed. When the test then interacts, and that interaction depends on a value a passive effect published (a ref, a subscription, a timer), the readiness signal must be `await act(async () => { render(...) })` — only `act` guarantees pending effects are flushed on exit. It only surfaces under CPU contention, which is why the file passes when run alone and goes flaky only under full-workspace concurrency.
- **Guard tests must prove they can fail**: a test pinning a tripwire / guard / cleanup ("X never happens") is validated at authoring time with a one-shot mutation check — temporarily disable the guard (stage the file or work on a copy first), confirm the test goes red, restore and verify by diff — and the run report carries that evidence. A negative assertion additionally needs a positive companion pinning the selector/key prefix it negates, or selector drift lets it pass vacuously.
- **Substring copy variants need exact equality**: when a new user-facing string is a substring/superstring of an existing one, assert with exact equality plus a negative assertion on the sibling variant — a positive substring match stays green after the variant is removed.
- **Cross-package parity tests must be CI-reachable**: check `.github/workflows/cicd.yml` path filters so the change class the test guards actually triggers the job it lives in. A guard that runs on only one side is worse than none.
- **Fake timers exclude RTL waiters**: while `vi` fake timers are installed, `waitFor` / `findBy*` are forbidden — RTL cannot see the fake clock, so the waiter polls a frozen clock until `testTimeout` (the mechanism behind whole-integer 30s timeouts). Tripwire: file-level `afterEach(() => vi.useRealTimers())`.
- **Flake work needs a calibrated baseline**: before fixing, find a load that actually reproduces the failure and record the pre-fix baseline (an uncalibrated all-green proves nothing), and run the whole file and suite to learn whether the named symptom is one instance of a class. Acceptance is repeated full-suite runs — concurrency is the trigger — never a single-file pass. A heavyweight render test whose runtime nears half of `testTimeout` is over budget: shrink the rendered volume (e.g. inject a small `pageSize`), don't raise the global timeout.
- **Blocking UI checklist**: When adding a modal, overlay, dialog, or any `fixed`/`z-*` element that covers the viewport, verify that E2E test helpers dismiss or skip it. Full-screen overlays block all Playwright `.click()` calls and cause silent timeout failures.
- **E2E must run in CI**: E2E jobs must not be disabled (`if: false`) for more than one release cycle. If a job is temporarily skipped, create a tracking issue.
