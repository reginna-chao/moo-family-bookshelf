/** Forgot-secret hint under the verification step: the recovery form on the official server, the
 *  admin on a self-hosted one. Twin of the Extension's; copy in shared/src/recovery/messages.ts. */

import { getVerifyRecoveryLink } from "moo-family-bookshelf-shared/config/links";
import {
  FORGOT_SECRET_LINK_LABEL,
  FORGOT_SECRET_QUESTION,
  FORGOT_SECRET_SELF_HOSTED,
} from "moo-family-bookshelf-shared/recovery/messages";

const RECOVERY_LINK = getVerifyRecoveryLink({ appVersion: __APP_VERSION__ });

interface ForgotSecretHintProps {
  /** True when the adopted server is the official default; the caller decides. */
  official: boolean;
}

export function ForgotSecretHint({ official }: ForgotSecretHintProps) {
  if (!official) {
    return (
      <p className="mt-4 text-center text-xs text-gray-500">
        {FORGOT_SECRET_SELF_HOSTED}
      </p>
    );
  }
  return (
    <p className="mt-4 text-center text-xs text-gray-500">
      {FORGOT_SECRET_QUESTION}
      <a
        href={RECOVERY_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-1 text-blue-600 underline hover:text-blue-700"
      >
        {FORGOT_SECRET_LINK_LABEL}
      </a>
    </p>
  );
}
