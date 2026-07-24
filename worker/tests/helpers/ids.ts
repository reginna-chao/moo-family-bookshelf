/**
 * Shared test userId fixtures.
 *
 * Production userIds are SHA-256 hex digests derived from the account email
 * (see `extension/src/crypto/hash.ts`). Since BE-8, `isValidUserId` enforces
 * the strict 64-hex rule (`^[a-f0-9]{64}$`) on EVERY route, so tests must use
 * real 64-char lowercase-hex ids — the old non-hex placeholders ("user1",
 * "alice", …) are now rejected with 400 INVALID_USER_ID.
 *
 * Each constant below is a distinct, deterministic 64-hex value. They are
 * intentionally human-readable (a repeated nibble pattern) so failures stay
 * easy to eyeball while remaining valid SHA-256-shaped ids. Keep distinctness
 * relationships intact (USER1 ≠ USER2, ALICE ≠ BOB, …).
 */

/** Build a deterministic 64-hex id from a single hex nibble. */
function hexId(nibble: string): string {
  return nibble.repeat(64);
}

export const USER1 = hexId("1");
export const USER2 = hexId("2");
export const USER3 = hexId("3");
export const USER4 = hexId("4");
export const USER5 = hexId("5");
export const OWNER1 = hexId("a");
export const OWNER2 = hexId("b");
export const ALICE = hexId("c");
export const BOB = hexId("d");
export const CHARLIE = hexId("e");
export const DAVE = hexId("f");

/** Extra distinct ids for tests that need many members / outsiders. */
export const OUTSIDER =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const STRANGER =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

/**
 * A syntactically-valid-but-arbitrary id, useful where a test needs "some other
 * user that does not exist" without caring about identity.
 */
export const NOBODY =
  "9999999999999999999999999999999999999999999999999999999999999999";

/** Build N distinct valid 64-hex ids (e.g. for rate-limit fan-out loops). */
export function makeUserId(index: number): string {
  const hex = index.toString(16).padStart(64, "0");
  return hex;
}
