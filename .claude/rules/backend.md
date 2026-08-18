## Backend Architecture Rules

Applies to: `worker/src/`

### Tech Stack

- Cloudflare Workers (TypeScript)
- Cloudflare KV for storage
- Hono (lightweight web framework for Workers)
- Vitest + Miniflare for testing

### Project Structure

```
worker/src/
├── index.ts          # Worker entry point + Hono app
├── routes/
│   ├── user.ts       # Personal settings API
│   ├── family.ts     # Family group API
│   ├── bookshelf.ts  # Family bookshelf aggregation API
│   ├── borrow.ts     # Family book borrow-request API
│   ├── publicShelf.ts # Public shelf CRUD + public share-token query
│   ├── auth.ts       # Auth lookup & token refresh
│   └── verify.ts     # PWA login verification routes (PIN/pattern/OTP)
├── services/
│   ├── verification.ts # Verification gate — shared by family/auth/verify routes
│   └── publicShelf.ts  # Public-shelf snapshot writes — shared by user/publicShelf routes
├── middleware/
│   ├── auth.ts       # Request authentication
│   └── rateLimit.ts  # Rate limiting
├── schemas/
│   └── common.ts     # Shared Zod schemas (userId/familyId/shareToken/PIN formats + path params)
├── kv/
│   └── schema.ts     # KV key patterns and type definitions
└── utils/
    ├── crypto.ts     # hashSecret / timingSafeEqual primitives
    ├── env.ts        # Env bindings type + isDevMode() production-name guard
    ├── errors.ts     # jsonError() — typed { error: { code, message } } envelope
    ├── openapi.ts    # OpenAPI route helpers (jsonRes, INVALID_JSON defaultHook)
    ├── routes.ts     # Route classification (isPublicRoute / sensitiveBucketFor)
    └── validation.ts # Input validation helpers
```

**Layering.** A route module must never import business or security logic from a SIBLING route module — when two or more route modules need the same logic, it belongs in `services/`. That is why the verification gate lives in `services/verification.ts` rather than in `routes/verify.ts`, which now holds only the five `/verify` handlers. This is machine-enforced: an ESLint `no-restricted-imports` override in `worker/eslint.config.js`, scoped to `src/routes/**/*.ts`, blocks the `./*` and `**/routes/*` import patterns at lint time, so a new sibling import fails CI rather than depending on a reviewer catching it. (Coverage is static forms only — `import`, `import type`, `export … from`; the core rule does not inspect dynamic `import()`. That is a known boundary of the rule implementation, not an accepted usage.)

One honest caveat, so the rule is not read as more than it is:

- **`services/` here is NOT a transport-agnostic layer.** `services/verification.ts` is deliberately HTTP-aware (it imports Hono's `Context` and returns `Response` via `verificationErrorResponse`) so that all three gate entry points emit byte-identical error shapes from one place, and it depends on `middleware/rateLimit.ts` for the shared KV counter primitives. Both are accepted trade-offs — do not "fix" them by re-splitting the gate.

### API Design

- RESTful JSON API. All responses wrapped in `{ data, error }` envelope.
- Prefix: `/api/`
- Authentication: token-based (issued on family create/join).
- All data stored as plaintext JSON in KV; access controlled by auth tokens.
- **userId is NOT a credential.** It is `sha256("moo:" + email)` — email-derived and publicly guessable. Any public endpoint that mints a token for a userId or reveals data bound to it (`POST /api/family`, `POST /api/family/:id/join`, `POST /api/auth/lookup`) MUST run the shared verification gate — `validateVerification(...)` + `verificationErrorResponse(...)` from `services/verification.ts` — before any KV write, token mint, or disclosure of family data (familyId, member count, member list). Accounts with no `verify:{user_id}` record (or `method: "none"`) pass through unchanged; that is a documented residual risk, not an oversight.
  - One deliberate exception: the terminal `409 ALREADY_IN_FAMILY` conflict is answered BEFORE the gate in both create and join. It discloses a single boolean ("this userId is in some family") to an unverified caller. Rationale — no secret can make such a request succeed, so gating first would only prompt for a PIN and burn the account's attempt ceiling before refusing anyway. Keep create and join in the same order; do not add further pre-gate disclosures.
- `POST /api/auth/lookup` reports the requirement instead of erroring: verification configured + no `verifySecret` ⇒ HTTP 200 with `{ existingFamilyId: null, memberCount: 0, requiresVerification: BoolFlag.TRUE }`. Use `isVerificationConfigured()` for that probe so only ONE verify-record read happens per request.
- Read-only gate callers pass `consumeOtp: false` (lookup does). A one-time `code` secret must only be spent by the request that acts on it — the client sends the SAME secret to lookup and then to create/join.
- The gate enforces its own per-userId attempt ceiling (`VERIFY_ATTEMPT_*` in `services/verification.ts`, KV scope `verify`, 10/hour, `429 RATE_LIMITED`). It lives inside `validateVerification`, not in handlers — a new caller of the gate inherits it automatically and MUST NOT re-implement it. **The ceiling only ever measures a WRONG guess, and is consulted only AFTER the comparison**: `matchesSecret()` runs first, and the wrong-secret branch alone calls `peekPerUserRateLimit()` + `chargePerUserRateLimit()`. So a correct secret is admitted regardless of the ceiling and charges nothing — a third party who spends the window blocks further _guessing_, never the account owner's own lookup / create / join. A wrong guess arriving when the window is already spent returns `429 RATE_LIMITED` instead of `403 VERIFICATION_FAILED` and does not write the spent counter again. Do NOT move the ceiling check back in front of the comparison. Both helpers live in `middleware/rateLimit.ts`; `consumePerUserRateLimit()` is the single-shot composition of the two and stays the path for `enforcePerUserRateLimit()` (user / borrow / bookshelf / public-shelf / verify-write / family-write). Never duplicate the counting logic. Note that the gate's `verify` scope is distinct from the `verify-write` write ceiling in `routes/verify.ts` (`VERIFY_WRITE_LIMIT`, 30/hour, shared by the four authenticated verify-domain write handlers) — keep them on separate counters so wrong-guess throttling and the owner's own settings operations cannot crowd each other out. `routes/family.ts` mirrors that shape with `FAMILY_WRITE_LIMIT` (scope `family-write`, 30/hour), shared by its five authenticated write handlers (remove-member / displayName / member-settings / transfer-ownership / endpoint) and always charged to the AUTHENTICATED caller, never to the `:uid` path param — a counter keyed on someone else's id would be a victim-facing lever. Create and join stay off it deliberately. (`POST /api/family/:id/join` no longer keeps a standalone per-userId "join" counter — that charge-every-request counter was a victim-facing DoS lever and redundant with the "verify" attempt ceiling above, which is now join's only per-userId brake.)
- The caller-scoped lockout check (`verifyfail:{userId}:{caller}`) stays BEFORE any comparison — it is caller-keyed, so it is not a victim-facing lever.
- All three gate entry points are **sensitive public routes** (`sensitiveBucketFor()` / `isSensitivePublicRoute()` in `utils/routes.ts`): `POST /api/family`, `POST /api/family/:id/join`, `POST /api/auth/lookup`. Any public route where an unauthenticated caller can test a secret belongs on that tier. The classification is path-only — the rate-limit middleware runs before body parsing, so it cannot depend on whether a `verifySecret` was sent. The tier carries ONE limit (3/min/IP) but **two isolated counters**: `onboarding` (create / join, `ratelimit:sens:{ip}:{bucket}`) and `lookup` (`ratelimit:sens:lookup:{ip}:{bucket}`). Reason: one clean onboarding of a verified account spends 2 lookups (no-secret probe, then the same secret) + 1 create/join inside one minute from one IP, so a shared counter would 429 the first typo retry — or the second household member behind the same NAT / IPv6 /64. `rateLimitBucketFor()` in `middleware/rateLimit.ts` maps a route to `{ prefix, limit }`; add new tiers there and in `sensitiveBucketFor()`, never as a special case in the middleware body.
- Every rate counter here is KV get-then-put, which is not atomic and is not serialized. A parallel burst overshoots by the caller's concurrency (there is no fixed ~2× factor); the limits bound sequential traffic only. A hard bound requires Durable Objects or Cloudflare's native rate-limiting binding — an open decision, not implemented.
- `verifySecret` is classified at the HANDLER boundary by `sanitizeVerifySecret()` in `utils/validation.ts`, identically in all three gate entry points: absent / `null` / `""` ⇒ "not supplied" (each endpoint's documented no-secret behavior), any other non-string or longer than `VERIFY_SECRET_MAX_LENGTH` (256) ⇒ `400 INVALID_VERIFY_SECRET` via `verifySecretFormatResponse()`. A malformed body is a request-format error, never a failed verification — it must not reach `hashSecret` nor be charged against any budget.

### KV Key Patterns

| Key                                         | Value                                                                                                                                                                                                              | TTL                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `user:{user_id}`                            | Personal book list + sharing settings (JSON)                                                                                                                                                                       | None (persistent)                            |
| `family:{family_id}`                        | Family member list                                                                                                                                                                                                 | Configurable                                 |
| `member:{user_id}`                          | `family_id` (reverse lookup)                                                                                                                                                                                       | Follows family TTL                           |
| `publicshelves:{user_id}`                   | Public-shelf pointer list (`{ shelves: PublicShelf[] }`) — single source of truth for live share tokens                                                                                                            | None (persistent)                            |
| `public:{share_token}`                      | Plaintext public bookshelf (v1.2.0)                                                                                                                                                                                | User-configured (7/30/60/90 days or none)    |
| `verify:{user_id}`                          | PWA login verification settings (`method`, `hash`, `salt`, `prompted`, `secretUpdatedAt?`)                                                                                                                         | None (persistent)                            |
| `verifyfail:{user_id}:{caller}`             | Per-caller verification failures (`failCount`, `lockedUntil`, `startedAt?`); streaks older than `secretUpdatedAt` are void                                                                                         | 900s (15 minutes)                            |
| `otp:{user_id}`                             | One-time verification code                                                                                                                                                                                         | 300s (5 minutes)                             |
| `ratelimit:user:{scope}:{user_id}:{bucket}` | Per-userId request counter (hourly scopes: `verify`, `verify-write`, `put-books`, `family-prefs`, `family-write`, `public-shelf`; per-minute scopes: `bookshelf`, `borrow-create`, `borrow-list`, `borrow-update`) | 2 × window (hourly: 7200s; per-minute: 120s) |
| `ratelimit:{ip}:{bucket}`                   | Per-IP counter, standard tier (60/min)                                                                                                                                                                             | 120s                                         |
| `ratelimit:pub:{ip}:{bucket}`               | Per-IP counter, public tier (10/min)                                                                                                                                                                               | 120s                                         |
| `ratelimit:sens:{ip}:{bucket}`              | Per-IP counter, sensitive tier — family create / join (3/min)                                                                                                                                                      | 120s                                         |
| `ratelimit:sens:lookup:{ip}:{bucket}`       | Per-IP counter, sensitive tier — `POST /api/auth/lookup` (3/min, isolated from create / join)                                                                                                                      | 120s                                         |

**Public shelves are a single-writer domain.** `publicshelves:{user_id}` is written ONLY by the four public-shelf write handlers (create / update / reset-token / delete) in `routes/publicShelf.ts` — the sole exception is `DELETE /api/user/:id` in `routes/user.ts`, whose whole-account teardown also `delete`s the key (a wipe, not a list write — it can resurrect nothing) — and the local `writePublicShelves()` helper is the single `put`, deliberately not exported from `services/` so the hot paths cannot reach for it. `PUT`/`PATCH /api/user/:id/books` READ it (one pointer get each); `PUT /api/user/:id/family-prefs` does not even read it — it writes no snapshots, so it needs no pointer (see that handler's comment in `routes/user.ts`). None of the three ever writes it. Reason: `user:{user_id}` is a read-modify-write blob with no CAS and KV cross-colo reads can lag ~60s, so while the shelf list lived inside that record a books sync from a second device could roll a revoked token back to life and re-publish a snapshot the owner had just deleted. Migration is LAZY and handler-only: when the pointer key is absent, readers fall back to the legacy `user:{id}.publicSharing` field via the pure `resolvePublicShelves(pointer, legacy)` in `services/publicShelf.ts` (a non-null pointer record always wins, INCLUDING an empty `shelves` array — that means "migrated, no shelves"), and the next public-shelf WRITE creates it. Never migrate from the books path or from a GET handler. Once migrated, the PUT books handler omits the legacy field from the rebuilt record (PATCH strips it from the carried-over record) and it evaporates.

The read-side liveness guard in `GET /api/public/:shareToken` now validates ALL snapshots (was: permanent-only) against that pointer key — same `shelfId`, same `shareToken`, and an expiry that does not OUTLIVE the shelf's; any drift ⇒ 404 byte-identical to an unknown token — falling back to the legacy field only for un-migrated owners. The expiry half is MONOTONIC, not strict equality (`snapshotOutlivesShelf()` in `routes/publicShelf.ts`, where `null` = permanent = +∞): a snapshot promising LONGER than its shelf — including a permanent snapshot of a now time-limited shelf — is dead, because that is the direction an orphan or a rolled-back snapshot drifts in; a snapshot promising SHORTER stays readable and simply dies at its own earlier deadline unless refreshed, which is what a rewrite from a stale pointer read right after the owner EXTENDED the deadline looks like (strict equality used to 404 that, i.e. deny access the owner had just widened). Guard order stays snapshot miss → `expiresAt` backstop → liveness, and the handler still performs NO KV writes. Cost per public hit that holds a valid token: ONE extra small KV read (`publicshelves:{id}`) for a migrated owner, TWO for an un-migrated one — that pointer miss plus a fallback read of the FULL `user:{id}` books record, which is not small — and the second read disappears on their first shelf write. Residuals, stated honestly: LWW races remain possible WITHIN the writer domain (the owner's own concurrent shelf operations against each other), un-migrated users keep the old behavior until their first shelf write, a freshly rotated token can 404 for up to ~60s on a colo holding a stale pointer list (fail-closed, self-healing) — a window that now also applies to time-limited shelves — and the single-writer guarantee itself only holds once the pointer key is VISIBLE to the reading colo: for ~60s after the FIRST migration write (the revoke that creates the key) a colo holding a negative-cached miss still falls back to the legacy field, so a books save racing that one-time-per-user window can leave the link briefly readable; and element-level KV corruption stays unvalidated (container shape only — see the `resolvePublicShelves` JSDoc), fail-closed in every constructible case.

Platform constraint: Cloudflare KV rejects any `expirationTtl` below 60 seconds ("Invalid expiration_ttl, must be at least 60"). Fixed TTLs in this table already satisfy that. The floor is the shared production constant `KV_MIN_TTL_SECONDS` in `kv/schema.ts`; the test-side mock keeps a deliberately independent copy (see below). A DYNAMICALLY computed TTL must respect the floor in one of two ways, both in use today: the `public:{share_token}` snapshot (`services/publicShelf.ts`) treats a remaining lifetime under 60s as already expired — delete the key instead of putting with a sub-minimum TTL, which would throw and surface as a 500; the per-userId counter write (`chargePerUserRateLimit` in `middleware/rateLimit.ts`) clamps its derived `windowSec * 2` up to the floor with `Math.max`, so a future rate window under 30s yields a slightly longer-lived counter instead of a rejected put (a unit test drives a sub-30s window through the charge path and pins the clamped TTL at 60). The test-side KV mock (`worker/tests/helpers/mockKv.ts`) enforces this floor at `put` time — and is deliberately STRICTER than the platform for non-integer TTLs — so a regressed dynamic TTL fails unit tests instead of only surfacing against real KV. The tripwire only covers TTL values some test actually produces: a NEW derived TTL stays unchecked until a test drives it below the floor.

### Coding Conventions

- No `any` type. Strict TypeScript.
- Keep handler functions thin — extract business logic into helpers.
- Validate all inputs at the handler level before processing.
- Return proper HTTP status codes (400, 401, 403, 404, 429, 500).
- Error responses include machine-readable `code` field.

### Commands

- `pnpm dev` — `wrangler dev` (local dev with Miniflare)
- `pnpm build` — `wrangler deploy --dry-run`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint with `--max-warnings 0` (warnings fail)
- `pnpm test` — Vitest + Miniflare
