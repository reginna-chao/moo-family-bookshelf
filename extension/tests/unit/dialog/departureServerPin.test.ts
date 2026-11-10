import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiClient } from "@/api/client";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  SELF_DEPARTURE_UNTIL_KEY,
  USER_ID_KEY,
} from "@/constants";
import { DEPARTURE_SERVER_CHANGED_MESSAGE } from "@/dialog/departureServerPin";
import { useFamilySettingsDelete } from "@/dialog/useFamilySettingsDelete";
import { useFamilySettingsLeave } from "@/dialog/useFamilySettingsLeave";
import { isSelfDepartureActive } from "@/storage/selfDeparture";

/**
 * Leave-family and delete-account on a pinned server: a departure stays on the
 * server it was confirmed on. Once the client's endpoint differs, the next step is
 * not sent; the hook shows `DEPARTURE_SERVER_CHANGED_MESSAGE` and returns to idle.
 *
 * Real code end to end: both hooks, `runGuardedDeparture`, `ApiClient` and its
 * transport, the store-backed storage mock from `tests/setup.ts`. Stubbed: `fetch`,
 * which records what each server received and answers like the Worker. A held reply
 * or departure-mark write stays open until the test releases it, so the endpoint
 * moves while that step is in flight, as a family teardown or a confirmed endpoint
 * switch would.
 *
 * Positive companions: "the endpoint does not move" runs the same 401 and
 * `VERIFICATION_REQUIRED` paths through to their next request, so the "not sent"
 * assertions cannot pass because a step never ran. A request that already left is
 * not recalled: it lands on the server it was sent to and settles normally.
 *
 * The confirm is called directly, without `startConfirming`: that read happens before
 * the user confirms, so it is outside the run under test.
 */

const USER_ID = "user-123";
const FAMILY_ID = "fam-1";
const FAMILY_SERVER = "https://self-hosted.example";
const OFFICIAL = DEFAULT_API_ENDPOINT;
const SECRET = "482913";
const OLD_TOKEN = "a".repeat(64);
const NEW_TOKEN = "b".repeat(64);

const LEAVE = `DELETE /api/family/${FAMILY_ID}/member/${USER_ID}`;
const DELETE_USER = `DELETE /api/user/${USER_ID}`;
const VERIFY = `GET /api/user/${USER_ID}/verify`;
const REFRESH = "POST /api/auth/refresh";
const JOIN = `POST /api/family/${FAMILY_ID}/join`;

interface Reply {
  status: number;
  body: unknown;
}
interface Received {
  server: string;
  route: string;
  body: Record<string, unknown> | undefined;
  token: string | undefined;
}

const ok = (data: unknown): Reply => ({ status: 200, body: { data } });
const DEPARTED = ok({ ok: true });
const TOKEN_REFUSED: Reply = {
  status: 401,
  body: { error: { code: "UNAUTHORIZED", message: "revoked" } },
};
const SECRET_REQUIRED: Reply = {
  status: 403,
  body: { error: { code: "VERIFICATION_REQUIRED", message: "server text" } },
};

/** What the Worker answers when a test held nothing for the route. */
function workerReply({ route, token }: Received): Reply {
  switch (route) {
    case LEAVE:
    case DELETE_USER:
      return token === NEW_TOKEN ? DEPARTED : TOKEN_REFUSED;
    case REFRESH:
      return TOKEN_REFUSED;
    case JOIN:
      return ok({ authToken: NEW_TOKEN });
    case VERIFY:
      return ok({ method: "pin" });
    default:
      throw new Error(`Unexpected request: ${route}`);
  }
}

describe("a departure stays on the server it was confirmed on", () => {
  let client: ApiClient;
  let received: Received[];
  let held: Array<{ route: string; reply: Promise<Reply> }>;

  /** Keep the next request for `route` open; the returned function answers it. */
  function holdOnce(route: string): (reply: Reply) => void {
    let release: (reply: Reply) => void = () => {};
    const reply = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    held.push({ route, reply });
    return (answer) => release(answer);
  }

  /** Keep the next storage write open; released, it lands in the store as usual. */
  function holdMarkWrite(): () => void {
    const set = vi.mocked(chrome.storage.local.set);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The once-implementation is spent by now, so the inner call reaches the store.
    set.mockImplementationOnce((async (items: Record<string, unknown>) => {
      await gate;
      await chrome.storage.local.set(items);
    }) as never);
    return () => release();
  }

  async function handleFetch(url: string, init?: RequestInit) {
    const { origin, pathname } = new URL(url);
    const auth = (init?.headers as Record<string, string>).Authorization;
    const request: Received = {
      server: origin,
      route: `${init?.method ?? "GET"} ${pathname}`,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      token: auth?.replace("Bearer ", ""),
    };
    received.push(request);
    const index = held.findIndex((h) => h.route === request.route);
    const { status, body } = await (index === -1
      ? workerReply(request)
      : held.splice(index, 1)[0].reply);
    return new Response(JSON.stringify(body), { status });
  }

  /** Confirm the leave, leaving the run in flight; `settled` waits for it inside `act`. */
  function startLeave() {
    const onLeave = vi.fn();
    const hook = renderHook(() =>
      useFamilySettingsLeave({
        familyId: FAMILY_ID,
        userId: USER_ID,
        apiClient: client,
        onLeave,
      }),
    );
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.handleLeaveConfirm();
    });
    const settled = () =>
      act(async () => {
        await pending;
      });
    return { hook, onLeave, settled };
  }

  /** Confirm the delete, leaving the run in flight; `settled` waits for it inside `act`. */
  function startDelete(currentSecret?: string) {
    const onLeave = vi.fn();
    const hook = renderHook(() =>
      useFamilySettingsDelete({
        userId: USER_ID,
        familyId: FAMILY_ID,
        apiClient: client,
        onLeave,
      }),
    );
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.handleDeleteConfirm(currentSecret);
    });
    const settled = () =>
      act(async () => {
        await pending;
      });
    return { hook, onLeave, settled };
  }

  const trail = () => received.map((r) => r.route);
  const sentTo = (server: string) =>
    received.filter((r) => r.server === server).map((r) => r.route);
  const inFlight = (...routes: string[]) =>
    vi.waitFor(() => expect(trail()).toEqual(routes), {
      timeout: 5000,
      interval: 5,
    });
  const markWrites = () =>
    vi
      .mocked(chrome.storage.local.set)
      .mock.calls.filter(
        (call) => SELF_DEPARTURE_UNTIL_KEY in (call[0] as object),
      ).length;

  /** The mark was up (its cleanup found the value it wrote and removed it), and is gone now. */
  async function expectMarkRemoved() {
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      SELF_DEPARTURE_UNTIL_KEY,
    );
    expect(await isSelfDepartureActive()).toBe(false);
  }

  async function expectLeaveStopped({
    hook,
    onLeave,
  }: ReturnType<typeof startLeave>) {
    expect(hook.result.current.leaveError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.leaveState).toBe("idle");
    expect(onLeave).not.toHaveBeenCalled();
    await expectMarkRemoved();
  }

  async function expectDeleteStopped({
    hook,
    onLeave,
  }: ReturnType<typeof startDelete>) {
    expect(hook.result.current.deleteError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.deleteState).toBe("idle");
    expect(onLeave).not.toHaveBeenCalled();
    await expectMarkRemoved();
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    received = [];
    held = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handleFetch(url, init)),
    );
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER_ID,
      [FAMILY_ID_KEY]: FAMILY_ID,
      [AUTH_TOKEN_KEY]: OLD_TOKEN,
      [API_ENDPOINT_KEY]: FAMILY_SERVER,
    });
    vi.clearAllMocks();
    client = new ApiClient(FAMILY_SERVER);
    client.setAuthToken(OLD_TOKEN);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  describe("useFamilySettingsLeave", () => {
    describe("when the endpoint moves", () => {
      it("sends no request when it moves during the departure mark's write", async () => {
        const releaseMark = holdMarkWrite();

        const leave = startLeave();
        expect(markWrites()).toBe(1);
        client.setEndpoint(OFFICIAL);
        releaseMark();
        await leave.settled();

        expect(received).toEqual([]);
        await expectLeaveStopped(leave);
      });

      it("does not resend when it moves during the request that gets a 401", async () => {
        const releaseLeave = holdOnce(LEAVE);

        const leave = startLeave();
        await inFlight(LEAVE);
        client.setEndpoint(OFFICIAL);
        releaseLeave(TOKEN_REFUSED);
        await leave.settled();

        expect(sentTo(OFFICIAL)).toEqual([]);
        expect(sentTo(FAMILY_SERVER)).toEqual([LEAVE]);
        await expectLeaveStopped(leave);
      });

      it("settles a request that already left and comes back a success", async () => {
        const releaseLeave = holdOnce(LEAVE);

        const { hook, onLeave, settled } = startLeave();
        await inFlight(LEAVE);
        client.setEndpoint(OFFICIAL);
        releaseLeave(DEPARTED);
        await settled();

        expect(onLeave).toHaveBeenCalledTimes(1);
        expect(hook.result.current.leaveError).toBe("");
        expect(sentTo(OFFICIAL)).toEqual([]);
        expect(sentTo(FAMILY_SERVER)).toEqual([LEAVE]);
        expect(await isSelfDepartureActive()).toBe(false);
      });
    });

    describe("when the endpoint does not move", () => {
      it("resends to the family's server after a 401 and leaves", async () => {
        const { hook, onLeave, settled } = startLeave();
        await settled();

        expect(sentTo(OFFICIAL)).toEqual([]);
        // The second LEAVE is the guarded resend, the third the transport's after its join.
        expect(sentTo(FAMILY_SERVER)).toEqual([
          LEAVE,
          REFRESH,
          LEAVE,
          REFRESH,
          JOIN,
          LEAVE,
        ]);
        expect(received.at(-1)?.token).toBe(NEW_TOKEN);
        expect(onLeave).toHaveBeenCalledTimes(1);
        expect(hook.result.current.leaveError).toBe("");
        expect(await isSelfDepartureActive()).toBe(false);
      });
    });
  });

  describe("useFamilySettingsDelete", () => {
    describe("when the endpoint moves", () => {
      it("sends no request and no secret when it moves during the departure mark's write", async () => {
        const releaseMark = holdMarkWrite();

        const del = startDelete(SECRET);
        expect(markWrites()).toBe(1);
        client.setEndpoint(OFFICIAL);
        releaseMark();
        await del.settled();

        expect(received).toEqual([]);
        await expectDeleteStopped(del);
      });

      it("does not resend the secret when it moves during the request that gets a 401", async () => {
        const releaseDelete = holdOnce(DELETE_USER);

        const del = startDelete(SECRET);
        await inFlight(DELETE_USER);
        client.setEndpoint(OFFICIAL);
        releaseDelete(TOKEN_REFUSED);
        await del.settled();

        expect(sentTo(OFFICIAL)).toEqual([]);
        expect(sentTo(FAMILY_SERVER)).toEqual([DELETE_USER]);
        expect(received[0].body).toEqual({ currentSecret: SECRET });
        await expectDeleteStopped(del);
      });

      it("does not re-read the method when it moves before VERIFICATION_REQUIRED lands", async () => {
        const releaseDelete = holdOnce(DELETE_USER);

        const del = startDelete();
        await inFlight(DELETE_USER);
        client.setEndpoint(OFFICIAL);
        releaseDelete(SECRET_REQUIRED);
        await del.settled();

        expect(sentTo(OFFICIAL)).toEqual([]);
        expect(sentTo(FAMILY_SERVER)).toEqual([DELETE_USER]);
        expect(trail()).not.toContain(VERIFY);
        await expectDeleteStopped(del);
      });
    });

    describe("when the endpoint does not move", () => {
      it("resends the secret to the family's server after a 401 and deletes", async () => {
        const { hook, onLeave, settled } = startDelete(SECRET);
        await settled();

        expect(sentTo(OFFICIAL)).toEqual([]);
        // The second delete is the guarded resend, the third the transport's after its join.
        expect(sentTo(FAMILY_SERVER)).toEqual([
          DELETE_USER,
          REFRESH,
          DELETE_USER,
          REFRESH,
          JOIN,
          DELETE_USER,
        ]);
        const deletes = received.filter((r) => r.route === DELETE_USER);
        expect(deletes.map((r) => r.body)).toEqual(
          Array(3).fill({ currentSecret: SECRET }),
        );
        expect(received.at(-1)?.token).toBe(NEW_TOKEN);
        expect(onLeave).toHaveBeenCalledTimes(1);
        expect(hook.result.current.deleteError).toBe("");
        expect(await isSelfDepartureActive()).toBe(false);
      });

      it("re-reads the method on the family's server after VERIFICATION_REQUIRED", async () => {
        const releaseDelete = holdOnce(DELETE_USER);

        const { hook, onLeave, settled } = startDelete();
        await inFlight(DELETE_USER);
        releaseDelete(SECRET_REQUIRED);
        await settled();

        expect(sentTo(OFFICIAL)).toEqual([]);
        expect(sentTo(FAMILY_SERVER)).toEqual([DELETE_USER, VERIFY]);
        expect(hook.result.current.requiredMethod).toBe("pin");
        expect(hook.result.current.deleteState).toBe("confirming");
        expect(hook.result.current.deleteError).toBe("");
        expect(onLeave).not.toHaveBeenCalled();
        expect(await isSelfDepartureActive()).toBe(false);
      });
    });
  });
});
