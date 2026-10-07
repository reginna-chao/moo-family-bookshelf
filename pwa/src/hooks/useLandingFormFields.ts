import { useState, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { REMEMBERED_LOGOUT_KEY, REMEMBER_SYNC_CODE_KEY } from "@/hooks/useAuth";
import { useSyncCodeHostVerdict } from "@/hooks/useSyncCodeHostVerdict";
import type { UseSyncCodeHostVerdictResult } from "@/hooks/useSyncCodeHostVerdict";

export interface UseLandingFormFieldsResult {
  syncCodeInput: string;
  setSyncCodeInput: Dispatch<SetStateAction<string>>;
  hostVerdict: UseSyncCodeHostVerdictResult;
  showCode: boolean;
  setShowCode: Dispatch<SetStateAction<boolean>>;
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  rememberSyncCode: boolean;
  setRememberSyncCode: Dispatch<SetStateAction<boolean>>;
  syncCodeError: string;
  setSyncCodeError: Dispatch<SetStateAction<string>>;
  emailError: string;
  setEmailError: Dispatch<SetStateAction<string>>;
}

/**
 * The manual form's field values and their per-field errors. Called by the
 * always-mounted `LandingPage`, so what the user typed survives a trip through
 * the verification prompt or the consent gate and back to the form.
 */
export function useLandingFormFields(
  initialSyncCode: string,
): UseLandingFormFieldsResult {
  // Seeded so a prefill is in the field at FIRST render, which the verdict hook counts as settled
  // (trigger 4 — docs/architecture.md → 同步碼位址的驗證與揭露). Later changes: the effect below.
  const [syncCodeInput, setSyncCodeInput] = useState(initialSyncCode);
  // Holds the `@host` warning back until the typed code settles, so it cannot
  // flash on every intermediate keystroke.
  const hostVerdict = useSyncCodeHostVerdict(syncCodeInput);
  const [showCode, setShowCode] = useState(false);
  const [email, setEmail] = useState("");
  const [rememberSyncCode, setRememberSyncCode] = useState(() => {
    return localStorage.getItem(REMEMBER_SYNC_CODE_KEY) !== "0";
  });

  // Pick up remembered sync code from localStorage (logout with "remember" enabled)
  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBERED_LOGOUT_KEY);
    if (remembered) {
      localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
      setSyncCodeInput(remembered);
    }
  }, []);

  // Update field if initialSyncCode changes (QR code, invite link, or remembered logout via state)
  useEffect(() => {
    if (initialSyncCode) {
      setSyncCodeInput(initialSyncCode);
    }
  }, [initialSyncCode]);

  const [syncCodeError, setSyncCodeError] = useState("");
  const [emailError, setEmailError] = useState("");

  return {
    syncCodeInput,
    setSyncCodeInput,
    hostVerdict,
    showCode,
    setShowCode,
    email,
    setEmail,
    rememberSyncCode,
    setRememberSyncCode,
    syncCodeError,
    setSyncCodeError,
    emailError,
    setEmailError,
  };
}
