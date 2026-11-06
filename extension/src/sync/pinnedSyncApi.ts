// Keeps one book sync (#457), or one manual Save's full PUT (#463), on the server it was
// triggered on — docs/architecture.md → 書單同步.

import type { ApiClient } from "../api/client";

/** The API calls a book sync makes; a manual Save's full PUT uses the two book-list ones. */
export type SyncApi = Pick<
  ApiClient,
  | "getPersonalBooks"
  | "updatePersonalBooks"
  | "listBorrowRequests"
  | "updateBorrowStatus"
>;

export const SYNC_SERVER_CHANGED_MESSAGE =
  "伺服器已更換，這次同步已停止。請再同步一次。";

export class SyncServerChangedError extends Error {
  constructor() {
    super(SYNC_SERVER_CHANGED_MESSAGE);
    this.name = "SyncServerChangedError";
  }
}

/**
 * Reads the client's endpoint NOW, so call it synchronously when the sync is
 * triggered, before its first await. Each returned method rejects with
 * `SyncServerChangedError`, without calling the client, once the endpoint
 * differs. The compare and the client's own endpoint read share one synchronous
 * run: never put an `await` between them.
 *
 * It compares the endpoint only, and guards against book-list and borrow calls
 * reaching another server. An endpoint that never changed, or that changed and
 * came back, does not stop the sync: a teardown on the same server has no token
 * left, so the call gets a 401 and writes nothing; after a rejoin the write goes
 * to the user's own record. The client's internal token-refresh request does not
 * pass through here and is out of scope.
 *
 * The manual Save's full PUT and its 409 re-read use it the same way (#463,
 * `uploadPersonalShelf`): pinned when Save is pressed, stopped on the same terms.
 */
export function pinSyncApi(
  apiClient: SyncApi & Pick<ApiClient, "getEndpoint">,
): SyncApi {
  const server = apiClient.getEndpoint();
  const assertSameServer = (): void => {
    if (apiClient.getEndpoint() !== server) throw new SyncServerChangedError();
  };
  // `async` turns the throw into a rejection, so callers' await / try-catch behave as for a failed call.
  return {
    async getPersonalBooks(...args) {
      assertSameServer();
      return apiClient.getPersonalBooks(...args);
    },
    async updatePersonalBooks(...args) {
      assertSameServer();
      return apiClient.updatePersonalBooks(...args);
    },
    async listBorrowRequests(...args) {
      assertSameServer();
      return apiClient.listBorrowRequests(...args);
    },
    async updateBorrowStatus(...args) {
      assertSameServer();
      return apiClient.updateBorrowStatus(...args);
    },
  };
}
