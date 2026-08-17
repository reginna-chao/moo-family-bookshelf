/**
 * API endpoint URL validation — the single copy shared by Extension and PWA.
 *
 * This is a security boundary: the value it blesses is what a member's auth
 * token and full book list get sent to. Two clients disagreeing on the rules is
 * exactly the drift `shared/` exists to prevent, so neither app may keep a
 * local variant.
 *
 * Runtime-agnostic by construction — `URL` is the only global used, so this
 * module is equally safe in the Extension, the PWA, and Node scripts run under
 * `tsx` (see shared/eslint.config.js `no-restricted-globals`).
 */

/** Hostname patterns allowed over plain HTTP (dev / LAN self-hosting). */
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|.*\.local)$/;

/**
 * Validate an API endpoint URL and return it in canonical form.
 *
 * Rules:
 *   - HTTPS is always allowed; HTTP only for localhost / private-LAN hosts.
 *   - Embedded credentials (`https://real.example@evil.com`) are rejected — the
 *     browser fetches `evil.com` while the stored/displayed string reads as
 *     `real.example`, so a userinfo prefix lets the URL lie about its host.
 *   - The return value is normalized to `origin + pathname` with trailing
 *     slashes stripped. This folds an IDN host to punycode and collapses
 *     cosmetic differences (case, default port, trailing slash) so the
 *     stored/compared value is canonical. It also DROPS any `?query` and
 *     `#fragment` — a silent behaviour change from the older
 *     `raw.replace(/\/+$/, "")`, and a security improvement: a tail like
 *     `https://evil.com/#@real.example` can no longer make the stored and
 *     displayed endpoint read as a host the client will never call.
 *
 * Throws on any unparseable, credential-bearing, or unsafe-scheme URL — every
 * caller already handles the throw.
 *
 * One honest caveat, so this is not read as more than it is. Only the
 * NORMALIZATION is shared with the Worker's `validateApiEndpoint`
 * (worker/src/routes/family.ts): it produces the same `origin + pathname`, which
 * is what lets a member store byte-for-byte what the owner set. The ALLOW-SETS
 * deliberately DIVERGE, in both directions, because the two answer different
 * questions:
 *
 *   - The Worker decides what a family OWNER may publish to every OTHER member,
 *     so it blocks the shapes that cheaply steer someone else's client into a
 *     network: plain HTTP anywhere but `localhost` / `127.0.0.1`, every IPv6
 *     literal, and private / link-local IPv4 even over HTTPS.
 *   - This module decides what THIS user's own device may be pointed at, so LAN
 *     self-hosting has to keep working: plain HTTP is allowed across the whole
 *     private range below (10/8, 172.16/12, 192.168/16, 127/8, `*.local`), and
 *     over HTTPS IP literals are not classified at all.
 *   - Credentials run the other way: this module rejects them, the Worker
 *     accepts them — its `origin` normalization silently drops the userinfo, so
 *     `https://real.example@evil.com` is STORED as `https://evil.com`. That is
 *     harmless there precisely because what it keeps is the honest host, which
 *     is then what this module sees and what the switch confirmation shows.
 *
 * One consequence worth naming, because it looks like a bug from the UI:
 * everything this module allows beyond the Worker's set (the whole private
 * range, over either scheme) can be ADOPTED by a client but can never be
 * STORED on the family record — the Worker answers 400. A LAN-self-hosted
 * family therefore sits permanently in the "record carries no endpoint"
 * state, which useEndpointSwitch reads as the revert-to-default direction
 * and offers to every member exactly once. Declining is remembered, so it
 * is one prompt per device, not a loop — but it is not a misconfiguration.
 *
 * Do not "fix" one side into the other: widening the Worker to match this module
 * re-opens owner-controlled redirection into a member's LAN, and narrowing this
 * module to match the Worker breaks LAN self-hosting.
 */
export function validateEndpointUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid API endpoint URL: ${raw}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      `Unsafe API endpoint — credentials are not allowed in the URL: ${raw}`,
    );
  }

  const isHttps = parsed.protocol === "https:";
  const isPrivateHttp =
    parsed.protocol === "http:" && PRIVATE_HOST_RE.test(parsed.hostname);
  if (!isHttps && !isPrivateHttp) {
    throw new Error(
      `Unsafe API endpoint scheme — only HTTPS or private-network HTTP is allowed: ${raw}`,
    );
  }

  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}
