/**
 * The single authoritative source of the endpoint-disclosure rule for every
 * screen that discloses which backend the client is talking to: the screens
 * that collect a verification secret (the onboarding challenge and the re-auth
 * modal) and, since the disclosure is the same question, the onboarding
 * container's status note. That third caller collects no secret — it just tells
 * a self-hoster which server the create / join / recovery buttons below it will
 * hit — but it is bound by the same two invariants, which is exactly why it
 * calls this instead of reading the endpoint itself. All three call this; none
 * re-derives it, so the rule cannot drift into answers that disagree on the
 * same question.
 *
 * Two invariants live here and nowhere else:
 *
 * 1. The verdict is taken from the endpoint the client has ACTUALLY ADOPTED,
 *    never from input text. This is the rule PR #116 established: a sync code's
 *    `@host` is attacker-controlled text and is adopted only after the user
 *    confirms it, so classifying the typed text would let the UI vouch for an
 *    address the user has not accepted — the exact reassurance a spoofed host
 *    wants. The adopted endpoint, by contrast, has already passed
 *    `validateEndpointUrl` on its way into `ApiClient`, so it cannot disagree
 *    with where the secret is really about to be sent.
 *
 * 2. The official default discloses nothing (`kind: "none"`). A banner on every
 *    single challenge would train the user to scroll past the one time it
 *    carries meaning; the disclosure is worth attention only when the
 *    destination is NOT the project's own Worker.
 *
 * Taking an `ApiClient` instead of a `string` is deliberate: it makes it
 * structurally impossible for a call site to hand this function user input and
 * still typecheck, which is invariant 1 enforced by the compiler rather than by
 * a reviewer noticing.
 */

import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import type { ApiClient } from "../api/client";
import type { SyncCodeApiHostResult } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "../constants";

/**
 * Verdict for the endpoint the client has adopted — the only source a
 * secret-collecting screen may disclose. Returns `none` (render nothing) for the
 * official default endpoint.
 */
export function classifyAdoptedEndpoint(
  apiClient: ApiClient,
): SyncCodeApiHostResult {
  const adopted = apiClient.getEndpoint();
  return classifySyncCodeApiHost(
    adopted === DEFAULT_API_ENDPOINT ? undefined : adopted,
  );
}
