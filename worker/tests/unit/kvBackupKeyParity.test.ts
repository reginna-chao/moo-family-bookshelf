import { kvKeys } from "../../src/kv/schema";
import {
  PER_USER_RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_KEY_PREFIXES,
} from "../../src/middleware/rateLimit";
import {
  BackupError,
  classifyKey,
} from "../../../scripts/kv-backup/format.mjs";

/**
 * Worker KV keys <-> backup key classification parity tripwire.
 *
 * WHY. The daily backup (`worker/src/backup/source.ts` and the Node tools under
 * `scripts/kv-backup/`) classifies every listed KV key with `classifyKey` from
 * `scripts/kv-backup/format.mjs`: a saved family returns its prefix, a transient
 * family (auth / token / otp / qr / verifyfail / ratelimit) returns null, and an
 * UNKNOWN prefix throws and stops the whole backup. Those prefix lists are written
 * by hand, independently of the key builders in `worker/src/kv/schema.ts`, so a new
 * `kvKeys` builder (or a new rate-limit key prefix) would only surface as a
 * failed nightly backup in production. This file builds one key from EVERY
 * builder — iterating `Object.entries(kvKeys)` and calling each with as many
 * sample strings as its `.length`, so a newly added builder is covered without
 * editing this file — plus one sample `ratelimit:*` key per prefix EXPORTED by
 * `worker/src/middleware/rateLimit.ts`: `RATE_LIMIT_KEY_PREFIXES` (the per-IP
 * tiers) and `PER_USER_RATE_LIMIT_KEY_PREFIX` (the per-userId counters, which the
 * verification gate in `worker/src/services/verification.ts` charges through too).
 * Those keys have no `kvKeys` builder; deriving them from the exports means a
 * renamed or added prefix reaches this file without editing it. A positive
 * companion case pins that the per-IP list is non-empty and every entry is a
 * `ratelimit` key, so the derived list cannot go vacuously green.
 *
 * `EXPECTED` records the backup decision per builder (saved prefix or null). A new
 * builder with no entry fails the "has a backup decision" case on purpose: whether
 * a new key family is backed up must be decided, not inherited from a prefix match.
 *
 * LIVENESS. The last case proves `classifyKey` still throws on an unknown prefix,
 * so the "does not throw" assertions above it cannot pass vacuously.
 *
 * CI REACHABILITY (.claude/rules/test.md -> "Cross-package parity tests must be
 * CI-reachable"): `.github/workflows/cicd.yml` -> `worker-check` filters on both
 * `worker/**` and `scripts/**`, so a change on either side runs this file.
 */

const USER_ID = "0123456789abcdef0123456789abcdef";
const FAMILY_ID = "ab12-cd34";
const REQUEST_ID = "12345678-1234-1234-1234-123456789abc";

const ARGS: Record<string, string[]> = {
  user: [USER_ID],
  family: [FAMILY_ID],
  member: [USER_ID],
  kicked: [FAMILY_ID, USER_ID],
  auth: [USER_ID],
  authToken: ["tok_sample-auth-token"],
  verify: [USER_ID],
  verifyFail: [USER_ID, "ip:1.2.3.4"],
  otp: [USER_ID],
  qrToken: ["qr_sample-token"],
  borrow: [REQUEST_ID],
  borrowsByFamily: [FAMILY_ID],
  publicShelves: [USER_ID],
  newBookDefault: [USER_ID],
  publicShelf: ["share_sample-token"],
};

const EXPECTED: Record<string, string | null> = {
  user: "user:",
  family: "family:",
  member: "member:",
  kicked: "kicked:",
  auth: null,
  authToken: null,
  verify: "verify:",
  verifyFail: null,
  otp: null,
  qrToken: null,
  borrow: "borrow:",
  borrowsByFamily: "borrows:family:",
  publicShelves: "publicshelves:",
  newBookDefault: "newbookdefault:",
  publicShelf: "public:",
};

const builtKeys = Object.entries(kvKeys).map(([name, builder]) => {
  const args =
    ARGS[name] ?? Array.from({ length: builder.length }, () => USER_ID);
  return [name, (builder as (...a: string[]) => string)(...args)] as const;
});

const HAND_BUILT_RATE_LIMIT_KEYS = [
  ...RATE_LIMIT_KEY_PREFIXES.map((prefix) => `${prefix}:1.2.3.4:123`),
  `${PER_USER_RATE_LIMIT_KEY_PREFIX}:verify:${USER_ID}:123`,
];

describe("classifyKey parity with the Worker's KV keys", () => {
  it("builds a key from every kvKeys builder", () => {
    expect(builtKeys.length).toBe(Object.keys(kvKeys).length);
    expect(builtKeys.length).toBeGreaterThan(0);
    for (const [name, builder] of Object.entries(kvKeys))
      if (ARGS[name]) expect(ARGS[name]).toHaveLength(builder.length);
  });

  it.each(builtKeys)("has a backup decision for kvKeys.%s", (name) => {
    expect(EXPECTED).toHaveProperty(name);
  });

  it.each(builtKeys)("classifies kvKeys.%s (%s) as planned", (name, key) => {
    expect(() => classifyKey(key)).not.toThrow();
    expect(classifyKey(key)).toBe(EXPECTED[name]);
  });

  it("derives the rate-limit keys from a non-empty list of ratelimit prefixes", () => {
    expect(RATE_LIMIT_KEY_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of RATE_LIMIT_KEY_PREFIXES)
      expect(prefix.startsWith("ratelimit")).toBe(true);
  });

  it.each(HAND_BUILT_RATE_LIMIT_KEYS)(
    "ignores the hand-built rate-limit key %s",
    (key) => {
      expect(() => classifyKey(key)).not.toThrow();
      expect(classifyKey(key)).toBeNull();
    },
  );

  it("still throws on an unknown key prefix", () => {
    expect(() => classifyKey("future:x")).toThrow(BackupError);
  });
});
