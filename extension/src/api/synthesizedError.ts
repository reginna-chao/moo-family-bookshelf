/** Provenance marker for client-built error envelopes, used by `ApiClient` (`api/client.ts`). */

import type { ApiErrorPayload } from "./types";

/** Provenance marker for a client-built error envelope: `JSON.parse` never yields a symbol key, so no
 *  backend can forge it. See docs/architecture.md → 伺服器回傳資料的檢查 (`synthesized`). */
const CLIENT_SYNTHESIZED = Symbol("client-synthesized error payload");

interface SynthesizedErrorPayload extends ApiErrorPayload {
  [CLIENT_SYNTHESIZED]: true;
}

/** Build an error payload that is provably not server-supplied. */
export function synthesizeError(
  code: string,
  message: string,
): SynthesizedErrorPayload {
  return { code, message, [CLIENT_SYNTHESIZED]: true };
}

/** True only for payloads built by `synthesizeError` above. */
export function isClientSynthesized(payload: ApiErrorPayload): boolean {
  const marked: Partial<SynthesizedErrorPayload> = payload;
  return marked[CLIENT_SYNTHESIZED] === true;
}
