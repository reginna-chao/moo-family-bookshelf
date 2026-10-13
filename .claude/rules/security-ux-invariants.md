## Security-UX Invariants

These invariants MUST be respected by all security audits and code reviews.

### Auth Token Management

**Invariant 1**: Auth tokens MUST be validated on every API request that accesses user or family data. Unauthenticated requests MUST be rejected with 401.

**Invariant 2**: Auth tokens are issued on family create/join and refreshed transparently. Token expiry or invalidation MUST NOT silently drop data; the client MUST prompt re-authentication.

### Data Integrity

**Invariant 3**: The save-before-sync pattern MUST be enforced. Local changes to sharing preferences are NOT uploaded until the user explicitly presses "Save". No background auto-sync of unsaved state.

**Sanctioned exception — 新書預設開放 (#238)**: when the server-stored `newBookDefaultShared` is `BoolFlag.TRUE`, the Extension sync marks books NEW to the server as shared without a per-book save (`extension/src/sync/autoShare.ts`). The opt-in is the setting itself, saved by the user's own toggle in Settings (off by default). The exception never covers: the first sync (no record, or an empty one); a sync with more than `AUTO_SHARE_MAX_NEW` new books (then nothing is auto-shared); the target of a resolved id change (rename or legacy-id resolution), and any new id whose title matches a saved book this scrape did not find (an unpaired id change); an archived book (`isArchived === BoolFlag.TRUE`); or a book the user already has on the server — an existing book's flag is never changed by it. Any other auto-share is still a violation.

### Unbind Isolation

**Invariant 4**: When a user leaves a family, their userId MUST be removed from the family member list immediately. Subsequent family bookshelf queries MUST NOT include the former member's books. This removal is non-reversible without re-joining. (A stale no-CAS write can re-list a removed member without a `member:{uid}` pointer; the invariant holds because member-level authorization requires listed AND pointed — see "Family-scoped authorization is BIDIRECTIONAL" in `.claude/rules/backend.md`.)

### Settings Persistence

**Invariant 5**: Personal sharing preferences (`user:{userId}`) are tied to the user, NOT the family. Unbinding from a family MUST NOT delete or reset the user's sharing settings. Re-joining a different family MUST automatically reflect the user's existing sharing preferences.

### Abuse-Counter Keying

**Invariant 6**: Any counter that can reduce service availability (lockout, quota, rate limit) MUST NOT be chargeable by a third party on a caller-supplied target identity (a body/path userId or familyId). Counters keyed on the caller's own identity (authenticated callerId, or caller IP) always satisfy this. A counter keyed on a TARGET identity is permitted ONLY when it is charge-on-failure — evaluated AFTER the secret comparison and charged solely on the wrong-guess branch — so a correct secret is always admitted and the account owner can never be locked out by someone else's traffic. A charge-every-request counter keyed on someone else's id is a denial-of-service lever aimed at the victim. (Instance detail lives in `.claude/rules/backend.md` — `FAMILY_WRITE_LIMIT` charging the authenticated caller; the removed per-userId join counter, which was charge-every-request; and the SANCTIONED target-keyed exception, the `VERIFY_ATTEMPT_*` ceiling in `worker/src/services/verification.ts`.)
