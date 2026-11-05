import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApiClient,
  BorrowStatus,
  PERSONAL_BOOKS_SCHEMA_VERSION,
  type PersonalBooks,
} from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import {
  pinSyncApi,
  SYNC_SERVER_CHANGED_MESSAGE,
  SyncServerChangedError,
  type SyncApi,
} from "@/sync/pinnedSyncApi";

/**
 * pinSyncApi (#457): one book sync stays on the server it was triggered on.
 *
 * "Forwarding and rejecting" drives a mock client, because the question there
 * is only whether the underlying method ran and what came back.
 *
 * "No gap between the compare and the send" drives the REAL ApiClient with a
 * stubbed fetch: `const p = pinned.x(); client.setEndpoint(OTHER); await p;` must
 * still reach the original server. It holds only while no `await` sits between
 * the compare and the client's own read of `baseUrl`, so moving `request`
 * (#456 moves it to `transport.ts`) turns this red if it adds one.
 *
 * Accepted residual, pinned on purpose (docs/architecture.md → 書單同步): only the
 * endpoint is compared, so an endpoint that moved away and came back does not
 * stop the sync.
 */

const USER_ID = "user-1";
const FAMILY_ID = "fam-1";
const REQUEST_ID = "req-1";
const SELF_HOSTED = "https://self-hosted.example";
const OFFICIAL = DEFAULT_API_ENDPOINT;

const RECORD: PersonalBooks = {
  schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
  userId: USER_ID,
  displayName: "",
  books: [],
  lastUpdated: "2026-01-01T00:00:00.000Z",
};

const METHODS: Array<{
  name: keyof SyncApi;
  call: (api: SyncApi) => Promise<unknown>;
  args: unknown[];
  httpMethod: string;
  path: string;
  reply: unknown;
}> = [
  {
    name: "getPersonalBooks",
    call: (api) => api.getPersonalBooks(USER_ID),
    args: [USER_ID],
    httpMethod: "GET",
    path: `/api/user/${USER_ID}/books`,
    reply: { data: RECORD },
  },
  {
    name: "updatePersonalBooks",
    call: (api) => api.updatePersonalBooks(USER_ID, RECORD),
    args: [USER_ID, RECORD],
    httpMethod: "PUT",
    path: `/api/user/${USER_ID}/books`,
    reply: { data: { ok: true } },
  },
  {
    name: "listBorrowRequests",
    call: (api) => api.listBorrowRequests(FAMILY_ID),
    args: [FAMILY_ID],
    httpMethod: "GET",
    path: `/api/family/${FAMILY_ID}/borrow`,
    reply: { data: [] },
  },
  {
    name: "updateBorrowStatus",
    call: (api) => api.updateBorrowStatus(REQUEST_ID, BorrowStatus.RETURNED),
    args: [REQUEST_ID, BorrowStatus.RETURNED],
    httpMethod: "PATCH",
    path: `/api/borrow/${REQUEST_ID}`,
    reply: { data: { requestId: REQUEST_ID } },
  },
];

const NAMES = METHODS.map((m) => m.name);

/** A client whose endpoint the test moves, with one distinct result per method. */
function mockClient() {
  let endpoint = SELF_HOSTED;
  const results = Object.fromEntries(
    NAMES.map((name) => [name, { from: name }]),
  ) as Record<keyof SyncApi, object>;
  const spies = Object.fromEntries(
    NAMES.map((name) => [name, vi.fn().mockResolvedValue(results[name])]),
  ) as Record<keyof SyncApi, ReturnType<typeof vi.fn>>;
  const client = {
    ...spies,
    getEndpoint: () => endpoint,
  } as unknown as SyncApi & Pick<ApiClient, "getEndpoint">;
  return {
    client,
    spies,
    results,
    moveTo: (url: string) => {
      endpoint = url;
    },
  };
}

describe("pinSyncApi", () => {
  describe("forwarding and rejecting", () => {
    describe.each(METHODS)("$name", ({ name, call, args }) => {
      it("forwards the arguments and returns the client's result while the endpoint is unchanged", async () => {
        const { client, spies, results } = mockClient();

        await expect(call(pinSyncApi(client))).resolves.toBe(results[name]);

        expect(spies[name]).toHaveBeenCalledTimes(1);
        expect(spies[name]).toHaveBeenCalledWith(...args);
        for (const other of NAMES.filter((n) => n !== name)) {
          expect(spies[other]).not.toHaveBeenCalled();
        }
      });

      it("rejects without calling the client once the endpoint differs", async () => {
        const { client, spies, moveTo } = mockClient();
        const pinned = pinSyncApi(client);

        moveTo(OFFICIAL);

        await expect(call(pinned)).rejects.toBeInstanceOf(
          SyncServerChangedError,
        );
        expect(spies[name]).not.toHaveBeenCalled();
      });

      it("forwards again when the endpoint moved away and came back", async () => {
        const { client, spies, results, moveTo } = mockClient();
        const pinned = pinSyncApi(client);

        moveTo(OFFICIAL);
        moveTo(SELF_HOSTED);

        await expect(call(pinned)).resolves.toBe(results[name]);
        expect(spies[name]).toHaveBeenCalledTimes(1);
      });
    });

    it("pins the endpoint the client holds when pinSyncApi is called", async () => {
      const { client, spies, results, moveTo } = mockClient();

      moveTo(OFFICIAL);
      const pinned = pinSyncApi(client);

      await expect(pinned.getPersonalBooks(USER_ID)).resolves.toBe(
        results.getPersonalBooks,
      );
      expect(spies.getPersonalBooks).toHaveBeenCalledTimes(1);

      moveTo(SELF_HOSTED);
      await expect(pinned.getPersonalBooks(USER_ID)).rejects.toBeInstanceOf(
        SyncServerChangedError,
      );
      expect(spies.getPersonalBooks).toHaveBeenCalledTimes(1);
    });

    it("rejects with the exact user-facing copy", async () => {
      const { client, moveTo } = mockClient();
      const pinned = pinSyncApi(client);
      moveTo(OFFICIAL);

      const error = await pinned.getPersonalBooks(USER_ID).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("SyncServerChangedError");
      expect(error.message).toBe(
        "伺服器已更換，這次同步已停止。請再同步一次。",
      );
      expect(SYNC_SERVER_CHANGED_MESSAGE).toBe(
        "伺服器已更換，這次同步已停止。請再同步一次。",
      );
    });
  });

  describe("no gap between the compare and the send", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it.each(METHODS)(
      "$name reaches the pinned server when the endpoint moves right after the call",
      async ({ call, httpMethod, path, reply }) => {
        const fetchStub = vi.fn<
          (url: string, init?: RequestInit) => Promise<Response>
        >(async () => new Response(JSON.stringify(reply), { status: 200 }));
        globalThis.fetch = fetchStub as unknown as typeof fetch;
        const client = new ApiClient(SELF_HOSTED);
        const pinned = pinSyncApi(client);

        const inFlight = call(pinned);
        client.setEndpoint(OFFICIAL);
        await inFlight;

        expect(fetchStub).toHaveBeenCalledTimes(1);
        const [url, init] = fetchStub.mock.calls[0];
        expect(url).toBe(`${SELF_HOSTED}${path}`);
        expect(init?.method ?? "GET").toBe(httpMethod);

        // The move did land: the next call stops before it reaches fetch.
        await expect(call(pinned)).rejects.toBeInstanceOf(
          SyncServerChangedError,
        );
        expect(fetchStub).toHaveBeenCalledTimes(1);
      },
    );
  });
});
