// Option and result types of useEndpointSwitch, split out for the max-lines cap; the hook file
// re-exports them. See docs/architecture.md → 端點切換確認.

import type { ApiClient } from "../api/client";
import type { PendingEndpointSwitch } from "./pendingEndpointSwitch";

export interface UseEndpointSwitchOptions {
  apiClient: ApiClient;
  /** The family this screen is bound to; a confirm is refused once storage binds another one or none. */
  familyId: string;
  /** `apiEndpoint` from the family record; `undefined` = record has none. */
  familyEndpoint: string | undefined;
  /** True once the members request carrying `familyEndpoint` has resolved. */
  membersReady: boolean;
}

export interface UseEndpointSwitchResult {
  /** The switch awaiting a decision, or `null` when there is nothing to ask. */
  pending: PendingEndpointSwitch | null;
  /** True when the last `confirm` was refused by the client's URL validation: nothing switched, and
   *  the user has not been told yet. */
  confirmError: boolean;
  /** True when the last `confirm` switched the client but storage did not take all of it. First
   *  removal or endpoint write failed: a reload returns to the old server and asks again. A later
   *  step failed: the reload stays on the new server and does not ask again. Also set when the read
   *  after the write throws: the new endpoint is stored, as in the later-step case. */
  confirmSaveFailed: boolean;
  /** True when the last confirm found that storage no longer binds this family, or could not read
   *  it: the switch did not complete, and the user has not been told yet. */
  confirmBindingGone: boolean;
  /** The endpoint THIS device uses; sync code / invite / QR come from it, never the record. State, as
   *  setEndpoint() does not re-render. See docs/architecture.md → 端點切換確認. */
  adoptedEndpoint: string;
  /** Apply the switch and persist it, unless storage no longer binds this family. */
  confirm: () => void;
  /** Keep the current endpoint and remember the refusal. */
  decline: () => void;
  /** Acknowledge the refusal, binding-gone or save-failure notice. */
  dismissConfirmError: () => void;
}
