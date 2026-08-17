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
