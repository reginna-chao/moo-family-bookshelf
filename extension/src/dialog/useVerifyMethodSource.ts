import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import type { VerifyMethod } from "../api/types";

export interface VerifyMethodSource {
  currentMethod: VerifyMethod | null;
  loading: boolean;
  /** Adopt the method a save on the same server just set or reported. */
  setCurrentMethod: (method: VerifyMethod) => void;
  /** Pin the source as it is now. The returned check stays true while no other read began or
   *  landed and the client still points at that server. */
  pinSource: () => () => boolean;
  /** Read the method again from the client's current server. */
  reload: () => void;
}

/**
 * The account's verify method, together with the server it was read from.
 * The method and the current secret are only used on the server the method
 * was read from: a read whose server changed before it landed is dropped and
 * repeated on the client's current server.
 */
export function useVerifyMethodSource(
  apiClient: ApiClient,
  userId: string,
): VerifyMethodSource {
  const [currentMethod, setCurrentMethod] = useState<VerifyMethod | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadNonce, setLoadNonce] = useState(0);
  /** The server `currentMethod` was read from; null until a read lands. */
  const serverRef = useRef<string | null>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const server = apiClient.getEndpoint();
      const result = await apiClient.getVerifyMethod(userId);
      if (cancelled) return;
      if (apiClient.getEndpoint() !== server) {
        setLoadNonce((n) => n + 1);
        return;
      }
      serverRef.current = server;
      epochRef.current += 1;
      setCurrentMethod(result.data ? result.data.method : "none");
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, apiClient, loadNonce]);

  const pinSource = useCallback(() => {
    const server = serverRef.current;
    const epoch = epochRef.current;
    return () =>
      server !== null &&
      epochRef.current === epoch &&
      serverRef.current === server &&
      apiClient.getEndpoint() === server;
  }, [apiClient]);

  const reload = useCallback(() => {
    serverRef.current = null;
    epochRef.current += 1;
    setLoading(true);
    setLoadNonce((n) => n + 1);
  }, []);

  return { currentMethod, loading, setCurrentMethod, pinSource, reload };
}
