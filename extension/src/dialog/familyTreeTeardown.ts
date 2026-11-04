import { flushSync } from "react-dom";
import type { Dispatch, SetStateAction } from "react";
import type { ApiClient } from "../api/client";
import { DEFAULT_API_ENDPOINT } from "../constants";
import type { View } from "./App";

/**
 * Unmounts the family tree, then takes the live client off the family's server: its token is
 * dropped and its endpoint goes back to the official default.
 *
 * The order is the point (#454; docs/architecture.md → 離開家庭時一併清除): unmount cleanups
 * flush a pending favorite / hidden change, and the client reads its endpoint and token when
 * that request is sent, so the save must leave before the reset to reach the family's own
 * server, not the default.
 *
 * Only `main` mounts `FamilyDataProvider`, so every other view is left alone and Onboarding is
 * not remounted. `finally` is purely defensive: on React 19.3 neither an unmount-cleanup error
 * nor an updater error is rethrown out of `flushSync` (both go to the root's uncaught-error
 * path). Were one to surface, the client must still leave the old server, token included, or
 * the next join would go there.
 *
 * Callers must be outside React's lifecycle, where `flushSync` cannot flush; all current ones
 * run after an await.
 */
export function unmountFamilyTreeThenResetClient(
  client: Pick<ApiClient, "setAuthToken" | "setEndpoint">,
  setView: Dispatch<SetStateAction<View>>,
): void {
  try {
    flushSync(() => setView((v) => (v === "main" ? "loading" : v)));
  } finally {
    client.setAuthToken(null);
    client.setEndpoint(DEFAULT_API_ENDPOINT);
  }
}
