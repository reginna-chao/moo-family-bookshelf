import { useCallback } from "react";
import { departureBindingIsCurrent } from "./departureBinding";

/**
 * Wraps `onLeave` for a successful leave so it runs only while storage still binds this account
 * and family. The leave hook's closure holds the callback from the render where the user
 * confirmed, so the check compares the account and family they were looking at then.
 */
export function useBoundDepartureLeave({
  userId,
  familyId,
  onLeave,
}: {
  userId: string;
  familyId: string;
  onLeave: () => void;
}): () => void {
  return useCallback(() => {
    void departureBindingIsCurrent({ userId, familyId }).then((current) => {
      if (current) onLeave();
    });
  }, [userId, familyId, onLeave]);
}
