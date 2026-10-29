// Forgot-secret hint beside the verification step: the recovery form on the official server, the
// admin on a self-hosted one. Rendered in the Dialog, never in the secure frame; copy in shared/.

import { getVerifyRecoveryLink } from "moo-family-bookshelf-shared/config/links";
import {
  FORGOT_SECRET_LINK_LABEL,
  FORGOT_SECRET_QUESTION,
  FORGOT_SECRET_SELF_HOSTED,
} from "moo-family-bookshelf-shared/recovery/messages";
import type { ApiClient } from "../api/client";
import { classifyAdoptedEndpoint } from "./adoptedEndpoint";

const RECOVERY_LINK = getVerifyRecoveryLink({ appVersion: __APP_VERSION__ });

export interface ForgotSecretHintProps {
  /** Its ADOPTED endpoint decides official vs self-hosted (never input text). */
  apiClient: ApiClient;
}

export function ForgotSecretHint({ apiClient }: ForgotSecretHintProps) {
  if (classifyAdoptedEndpoint(apiClient).kind !== "none") {
    return (
      <p className="moo-forgot-secret-hint">{FORGOT_SECRET_SELF_HOSTED}</p>
    );
  }
  return (
    <p className="moo-forgot-secret-hint">
      {FORGOT_SECRET_QUESTION}
      <a href={RECOVERY_LINK} target="_blank" rel="noopener noreferrer">
        {FORGOT_SECRET_LINK_LABEL}
      </a>
    </p>
  );
}
