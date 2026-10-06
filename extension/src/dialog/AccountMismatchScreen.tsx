import { useState } from "react";
import type { ApiClient } from "../api/client";
import { DialogFooter } from "./DialogFooter";
import { forgetStoredAccount } from "./familyBindingReset";

export interface AccountMismatchScreenProps {
  apiClient: ApiClient;
  /** Called once this device's stored account is gone; the host shows onboarding. */
  onAccountForgotten: () => void;
}

/**
 * Shown INSTEAD of the main view when the Readmoo account on the page is not
 * the one the extension was set up with (issue #271). Nothing behind it is
 * mounted, so no shelf data loads and no write path is reachable.
 */
export function AccountMismatchScreen({
  apiClient,
  onAccountForgotten,
}: AccountMismatchScreenProps) {
  const [resetting, setResetting] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleReset = async () => {
    setResetting(true);
    setFailed(false);
    try {
      await forgetStoredAccount(apiClient);
    } catch {
      // Storage still holds the old account: stay here rather than open it.
      setFailed(true);
      setResetting(false);
      return;
    }
    onAccountForgotten();
  };

  return (
    <div className="moo-app__fill">
      <div role="alert" className="moo-family-gone-notice">
        <h2 className="moo-account-mismatch__title">
          目前登入的讀墨帳號與設定時不同
        </h2>
        <div className="moo-family-gone-notice__text">
          這個瀏覽器的家庭書櫃是用另一個讀墨帳號設定的，所以不會顯示家庭書櫃，也不會把現在這個帳號的書單同步到原本的帳號。要用原本的帳號，請改用那個帳號登入讀墨，再打開家庭書櫃。
        </div>
        <p className="moo-account-mismatch__hint">
          重新設定只會清除這個瀏覽器上的設定，原本的帳號仍會留在家庭裡。
        </p>
        {failed && (
          <p className="moo-account-mismatch__error">
            這個瀏覽器上的設定沒有清除成功，請再試一次。
          </p>
        )}
        <div className="moo-family-gone-notice__actions">
          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={resetting}
            className="moo-button moo-button--sm"
          >
            改用這個帳號重新設定
          </button>
        </div>
      </div>
      <DialogFooter />
    </div>
  );
}
