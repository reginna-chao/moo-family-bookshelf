/**
 * Sync-code fixtures for every `@host` disclosure test in this app — the
 * classifier unit tests, the settle-timing hook tests and the component tests
 * all draw their codes from here.
 *
 * Twin of pwa/tests/helpers/syncCodeHostFixtures.ts.
 *
 * These constants used to be re-declared inline in each test file, and had
 * already drifted: HALF_TYPED_PREFIXES existed in three different lengths
 * (8 / 12 / 15 entries), so the two apps were no longer proving the same thing
 * about a security-facing warning. The twins are held identical by the copy of
 * tests/unit/useSyncCodeHostVerdict.parity.test.ts that each app's suite runs.
 */

/** A code with no `@host` at all — the app's default endpoint. */
export const NO_HOST_CODE = "moo-ab12-cd34";

/** An `@host` the join path would adopt, and the endpoint it resolves to. */
export const TRUSTED_CODE = "moo-ab12-cd34@https://api.moofamily.app";
export const TRUSTED_ENDPOINT = "https://api.moofamily.app";

/**
 * The attack the warning exists for. Everything after the FIRST `@` is the host
 * segment, so `new URL()` reads `api.moofamily.app` as USERINFO and the browser
 * fetches `evil.com` — carrying the auth token and the whole book list with it.
 */
export const SPOOFED_CODE = "moo-ab12-cd34@https://api.moofamily.app@evil.com";

/** A legitimate LAN self-hosting endpoint (plain HTTP is allowed in-range). */
export const LAN_CODE = "moo-ab12-cd34@http://192.168.1.50:8787";
export const LAN_ENDPOINT = "http://192.168.1.50:8787";

/**
 * Every intermediate value on the way to LAN_CODE that classifies as `invalid`.
 * This run is the whole reason the settle delay exists: live, it was 15
 * consecutive keystrokes of warning for a user typing a perfectly good address.
 *
 * The run stops at `…192.168.` deliberately — one character further and the
 * URL parses as an in-range LAN host, i.e. `valid`, which is a different
 * assertion. Callers may rely on every entry here being genuinely `invalid`.
 */
export const HALF_TYPED_PREFIXES = [
  "moo-ab12-cd34@h",
  "moo-ab12-cd34@ht",
  "moo-ab12-cd34@htt",
  "moo-ab12-cd34@http",
  "moo-ab12-cd34@http:",
  "moo-ab12-cd34@http:/",
  "moo-ab12-cd34@http://",
  "moo-ab12-cd34@http://1",
  "moo-ab12-cd34@http://19",
  "moo-ab12-cd34@http://192",
  "moo-ab12-cd34@http://192.",
  "moo-ab12-cd34@http://192.1",
  "moo-ab12-cd34@http://192.16",
  "moo-ab12-cd34@http://192.168",
  "moo-ab12-cd34@http://192.168.",
];

/**
 * The spoof tail appended one character at a time onto TRUSTED_CODE: the moment
 * the first `@` of the tail lands, the named endpoint must disappear.
 */
export const SPOOF_TAILS = ["@", "@e", "@ev", "@evil.com"];
