/**
 * Display-side classification of a sync code's `@host` segment, shared by
 * Extension and PWA so both disclose the same thing about the same code.
 *
 * Separate from `endpointUrl.ts` on purpose: that module decides whether an
 * endpoint may be ADOPTED (and throws when it may not), this one turns the same
 * verdict into something renderable without a try/catch at every call site.
 */

import { validateEndpointUrl } from "./endpointUrl";

/**
 * Discriminated result of inspecting a pasted sync code's `@host` for DISPLAY.
 *
 * - `none`    — no `@host` (default endpoint), or the code is not yet parseable
 *               (e.g. still being typed). Show nothing.
 * - `valid`   — the `@host` passes the SAME validation the join path adopts;
 *               `endpoint` is the canonical value that would actually be
 *               adopted, so the disclosure cannot differ from where the browser
 *               would go.
 * - `invalid` — the `@host` is present but would be REJECTED on adoption
 *               (embedded credentials, unsafe scheme, unparseable). The display
 *               must warn instead of reassuring — the reassuring line here would
 *               lend a spoofed address false legitimacy.
 */
export type SyncCodeApiHostResult =
  { kind: "none" } | { kind: "valid"; endpoint: string } | { kind: "invalid" };

/**
 * Classify an `@host` segment for display. Never throws.
 *
 * `endpoint` is the canonical `origin + pathname`, not the bare host: a
 * plain-HTTP LAN endpoint and its HTTPS namesake must be distinguishable in the
 * UI, and a sub-path endpoint must show the path it will actually call.
 */
export function classifySyncCodeApiHost(
  apiHost: string | undefined,
): SyncCodeApiHostResult {
  if (!apiHost) return { kind: "none" };

  try {
    return { kind: "valid", endpoint: validateEndpointUrl(apiHost) };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * How long a sync code must hold still before an `invalid` verdict may reach
 * the user. Long enough to cover typing an `@host` one character at a time,
 * short enough that the warning still lands well before the user commits.
 * Shared so Extension and PWA cry wolf at exactly the same moment.
 */
export const SYNC_CODE_HOST_SETTLE_DELAY_MS = 600;

/**
 * Turn the LIVE verdict for an input field into the verdict that may actually
 * be rendered, given whether that value has SETTLED (user paused typing /
 * pasted / blurred / submitted, or never typed it at all because it was
 * prefilled from an invite link).
 *
 * Only `invalid` is delayed. A half-typed `@host` is `invalid` at nearly every
 * intermediate keystroke (`…@http://192.168.`) — nearly, because the URL parser
 * expands short-form IPv4, so one character further (`…@http://192.168.1`) is
 * host `192.168.0.1` and already `valid`. A warning that fires during normal
 * typing is one the user is trained to ignore — fatal here, because this
 * warning is the last human-facing defence against a userinfo-spoofed endpoint.
 * `valid` is positive information about the current value, so it stays live
 * with no delay.
 *
 * The not-settled case returns `none` — render NOTHING — rather than the
 * previously displayed verdict, and that is the whole point of this function.
 * Keeping the last `valid` note on screen would leave a reassuring "will
 * connect to api.example" standing for a value that is currently invalid:
 * append `@evil.com` to a valid host and the stale note would lend the spoof
 * exactly the legitimacy it was written to deny. We only ever DELAY the
 * warning; we never display something that contradicts the current input.
 */
export function displayedSyncCodeApiHost(
  live: SyncCodeApiHostResult,
  settled: boolean,
): SyncCodeApiHostResult {
  if (live.kind === "invalid" && !settled) return { kind: "none" };
  return live;
}
