import {
  parseSyncCodeApiHost,
  type SyncCodeApiHostResult,
} from "moo-family-bookshelf-shared/crypto/syncCode";
import type { OnboardingState } from "./useOnboardingFlow";

/** States `renderContent` gives a view of their OWN; every other one (a future state too) falls
 *  through to `<IdleView>`, hence a complement. Keep in step with `renderContent` in Onboarding.tsx. */
const DEDICATED_VIEW_STATES = new Set<OnboardingState>([
  "welcome",
  "error",
  "created",
  "recovery-choice",
  "recovery-join",
  "solo-recovery-confirm",
  "verify-prompt",
]);

/** Whether the view on screen renders the TYPED sync code's own host note.
 *  Exactly two do: `RecoveryJoinView` and `IdleView` (the fallback branch). */
function rendersTypedSyncCodeNote(state: OnboardingState): boolean {
  return state === "recovery-join" || !DEDICATED_VIEW_STATES.has(state);
}

/** Whether the container note would repeat the view's note (same validated address); hides only on
 *  equal `valid` endpoints. See docs/architecture.md → 揭露採用中的伺服器位址. */
export function isAdoptedNoteRedundant(
  state: OnboardingState,
  syncCodeInput: string,
  adopted: SyncCodeApiHostResult,
): boolean {
  if (adopted.kind !== "valid") return false;
  if (!rendersTypedSyncCodeNote(state)) return false;
  const typed = parseSyncCodeApiHost(syncCodeInput);
  return typed.kind === "valid" && typed.endpoint === adopted.endpoint;
}
