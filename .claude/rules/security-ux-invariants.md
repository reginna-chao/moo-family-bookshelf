## Security-UX Invariants

These invariants MUST be respected by all security audits and code reviews.

### Key Management & PWA Usability

**Invariant 1**: The encryption key is transmitted through exactly ONE carrier: the sync code. QR code, manual paste, and PWA URL sharing are different UI surfaces for the same carrier.

**Invariant 2**: The Extension is the sole generator of sync codes (and therefore keys). The PWA does not generate keys and cannot recover keys from the server.

**Invariant 3**: Any behavior that silently rotates the Extension's encryption key = invalidates all previously issued sync codes = directly breaks PWA usability. Therefore, Extension key rotation MUST: (a) only happen when necessary, (b) require explicit user confirmation, (c) provide a clear "regenerate sync code" entry point after rotation, and remind the user that PWA sessions need to re-login.

Any future security review that proposes stricter key rotation MUST simultaneously design a PWA notification or re-onboarding flow; otherwise the proposal MUST be rejected.

### Decrypt Failure Handling

**Invariant 4**: When the Extension cannot decrypt an existing server payload, it MUST abort the sync operation. It MUST NOT overwrite the server data with a payload encrypted under a different key.

**Invariant 5**: When the PWA cannot decrypt a member's payload, it MUST show an explicit error message. It MUST NOT silently show an empty bookshelf or "0 books" for that member.
