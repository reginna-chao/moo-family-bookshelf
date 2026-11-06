import type { ApiClient } from "../api/client";

export const DEPARTURE_SERVER_CHANGED_MESSAGE =
  "伺服器已更換，這次操作已停止。請再試一次。";

/**
 * Remembers the client's server for one leave-family or delete-account run.
 * Call it synchronously before the departure's first await. Call the returned
 * check in the same synchronous run as the client call it guards, never with an
 * `await` between them; it throws once the client's endpoint differs.
 * The PWA never switches servers, so there is no twin.
 * See docs/architecture.md → 離開家庭時一併清除.
 */
export function pinDepartureServer(
  apiClient: Pick<ApiClient, "getEndpoint">,
): () => void {
  const server = apiClient.getEndpoint();
  return () => {
    if (apiClient.getEndpoint() !== server) {
      throw new Error(DEPARTURE_SERVER_CHANGED_MESSAGE);
    }
  };
}
