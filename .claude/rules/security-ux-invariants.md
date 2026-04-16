## Security-UX Invariants

These invariants MUST be respected by all security audits and code reviews.

### Auth Token Management

**Invariant 1**: Auth tokens MUST be validated on every API request that accesses user or family data. Unauthenticated requests MUST be rejected with 401.

**Invariant 2**: Auth tokens are issued on family create/join and refreshed transparently. Token expiry or invalidation MUST NOT silently drop data; the client MUST prompt re-authentication.

### Data Integrity

**Invariant 3**: The save-before-sync pattern MUST be enforced. Local changes to sharing preferences are NOT uploaded until the user explicitly presses "Save". No background auto-sync of unsaved state.

### Unbind Isolation

**Invariant 4**: When a user leaves a family, their userId MUST be removed from the family member list immediately. Subsequent family bookshelf queries MUST NOT include the former member's books. This removal is non-reversible without re-joining.

### Settings Persistence

**Invariant 5**: Personal sharing preferences (`user:{userId}`) are tied to the user, NOT the family. Unbinding from a family MUST NOT delete or reset the user's sharing settings. Re-joining a different family MUST automatically reflect the user's existing sharing preferences.
