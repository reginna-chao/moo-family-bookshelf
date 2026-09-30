import { useRef } from "react";
import { ApiClient } from "@/api/client";

/**
 * The landing page's per-host `ApiClient` cache; returns `getJoinClient`.
 * Shared by the form submit, the join itself and the QR path.
 */
export function useLandingJoinClient(): (
  host: string | undefined,
) => ApiClient {
  // Cache join client per apiHost to avoid re-creating on each submit
  const joinClientRef = useRef<{
    host: string | undefined;
    client: ApiClient;
  } | null>(null);
  function getJoinClient(host: string | undefined): ApiClient {
    if (joinClientRef.current !== null && joinClientRef.current.host === host) {
      return joinClientRef.current.client;
    }
    const client = new ApiClient(host);
    joinClientRef.current = { host, client };
    return client;
  }

  return getJoinClient;
}
