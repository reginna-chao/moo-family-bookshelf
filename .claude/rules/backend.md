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
│   ├── auth.ts       # Auth lookup & token refresh
│   └── verify.ts     # PWA login verification (PIN/pattern/OTP)
├── middleware/
│   ├── auth.ts       # Request authentication
│   └── rateLimit.ts  # Rate limiting
├── kv/
│   └── schema.ts     # KV key patterns and type definitions
└── utils/
    └── validation.ts # Input validation helpers
```

### API Design

- RESTful JSON API. All responses wrapped in `{ data, error }` envelope.
- Prefix: `/api/`
- Authentication: token-based (issued on family create/join).
- All data stored as plaintext JSON in KV; access controlled by auth tokens.

### KV Key Patterns

| Key                             | Value                                                                                                                      | TTL                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `user:{user_id}`                | Personal book list + sharing settings (JSON)                                                                               | None (persistent)                         |
| `family:{family_id}`            | Family member list                                                                                                         | Configurable                              |
| `member:{user_id}`              | `family_id` (reverse lookup)                                                                                               | Follows family TTL                        |
| `public:{share_token}`          | Plaintext public bookshelf (v1.2.0)                                                                                        | User-configured (7/30/60/90 days or none) |
| `verify:{user_id}`              | PWA login verification settings (`method`, `hash`, `salt`, `prompted`, `secretUpdatedAt?`)                                 | None (persistent)                         |
| `verifyfail:{user_id}:{caller}` | Per-caller verification failures (`failCount`, `lockedUntil`, `startedAt?`); streaks older than `secretUpdatedAt` are void | 900s (15 minutes)                         |
| `otp:{user_id}`                 | One-time verification code                                                                                                 | 300s (5 minutes)                          |

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
- `pnpm lint` — ESLint
- `pnpm test` — Vitest + Miniflare
