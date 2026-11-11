import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient } from "@/api/client";
import { BoolFlag, type VerifyMethod } from "@/api/types";
import {
  useVerifyMethodFlow,
  VERIFY_SERVER_CHANGED_MESSAGE,
} from "@/dialog/useVerifyMethodFlow";

/**
 * The verify method and the current secret are only used on the server the
 * method was read from. Three kinds of case:
 *
 * - The client's server differs from that server BEFORE a step runs (picking a
 *   method, entering the current secret, saving): nothing is asked, opened or
 *   sent, the entered secret and the picked method are cleared, the hook shows
 *   `VERIFY_SERVER_CHANGED_MESSAGE`, and the method is read again from the
 *   client's current server. A read whose server changed before it landed is
 *   dropped and repeated.
 * - The client's server changes WHILE a save is in flight: the save's reply
 *   issues no request to the new server, the hook shows the same message, and
 *   the next step reads the method once from the client's current server.
 * - A save's reply (or the re-read its refusal triggers) is applied only while
 *   the method's source is unchanged since the save was sent: another read that
 *   began or landed meanwhile makes the reply stale even when the client points
 *   at the original server again. A stale reply is dropped, the hook shows the
 *   same message, and the method is read again from the client's current server.
 *
 * Real code end to end: the hook, `saveVerifyMethod`, `ApiClient` and its
 * transport. Stubbed: `fetch`, which records every request (server, route,
 * body) and answers like the Worker. `GET /verify` answers the method set for
 * that server in `methods` (`none` when unset); once `holdServerAGet()` ran,
 * server A's GETs are held until `releaseGet()`. Every `PUT /verify` waits for
 * `putReply`, which stays pending until `releasePut()` unless a case replaces it.
 *
 * Each step runs in its own synchronous `act()` and re-reads `result.current`:
 * a second call inside the same `act` would run the previous render's closure.
 */

const USER_ID = "user-123";
const SERVER_A = "https://self-hosted-a.example";
const SERVER_B = "https://self-hosted-b.example";
const SERVER_C = "https://self-hosted-c.example";
const TOKEN = "a".repeat(64);
const VERIFY_PATH = `/api/user/${USER_ID}/verify`;
const GET_VERIFY = `GET ${VERIFY_PATH}`;
const PUT_VERIFY = `PUT ${VERIFY_PATH}`;

interface Reply {
  status: number;
  body: unknown;
}

interface Received {
  server: string;
  route: string;
  body: string | undefined;
}

const SECRET_REQUIRED: Reply = {
  status: 403,
  body: { error: { code: "VERIFICATION_REQUIRED", message: "server text" } },
};

const CODE_SAVED: Reply = {
  status: 200,
  body: { data: { method: "code", prompted: BoolFlag.FALSE } },
};

describe("useVerifyMethodFlow", () => {
  let received: Received[];
  let methods: Map<string, VerifyMethod>;
  let heldGet: Promise<void> | null;
  let releaseGet: () => void;
  let releasePut: (reply: Reply) => void;
  let putReply: Promise<Reply>;

  async function handleFetch(url: string, init?: RequestInit) {
    const { origin, pathname } = new URL(url);
    const route = `${init?.method ?? "GET"} ${pathname}`;
    const body = typeof init?.body === "string" ? init.body : undefined;
    received.push({ server: origin, route, body });
    if (route === GET_VERIFY && origin === SERVER_A && heldGet !== null) {
      await heldGet;
    }
    const { status, body: replyBody } =
      route === PUT_VERIFY
        ? await putReply
        : {
            status: 200,
            body: { data: { method: methods.get(origin) ?? "none" } },
          };
    return new Response(JSON.stringify(replyBody), { status });
  }

  function holdServerAGet() {
    heldGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
  }

  function requestsTo(server: string, route: string) {
    return received.filter((r) => r.server === server && r.route === route);
  }

  async function mountOnServerA() {
    const apiClient = new ApiClient(SERVER_A);
    apiClient.setAuthToken(TOKEN);
    const hook = renderHook(() =>
      useVerifyMethodFlow({ userId: USER_ID, apiClient }),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return { apiClient, result: hook.result };
  }

  beforeEach(() => {
    received = [];
    methods = new Map();
    heldGet = null;
    releaseGet = () => {};
    putReply = new Promise<Reply>((resolve) => {
      releasePut = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handleFetch(url, init)),
    );
  });

  afterEach(() => {
    releaseGet();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends nothing to the new server until the next step when the endpoint moves during the save", async () => {
    methods.set(SERVER_B, "pattern");
    const { apiClient, result } = await mountOnServerA();
    expect(result.current.currentMethod).toBe("none");

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handleSave("code");
    });
    await vi.waitFor(
      () => expect(received.map((r) => r.route)).toContain(PUT_VERIFY),
      { timeout: 5000, interval: 5 },
    );
    apiClient.setEndpoint(SERVER_B);
    releasePut(SECRET_REQUIRED);
    await act(async () => {
      await pending;
    });

    expect(received.filter((r) => r.server === SERVER_B)).toEqual([]);
    expect(received.map(({ server, route }) => ({ server, route }))).toEqual([
      { server: SERVER_A, route: GET_VERIFY },
      { server: SERVER_A, route: PUT_VERIFY },
    ]);
    // Pins that request bodies are recorded, for the body checks below.
    expect(JSON.parse(requestsTo(SERVER_A, PUT_VERIFY)[0].body ?? "")).toEqual({
      method: "code",
    });
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.saveState).toBe("error");
    expect(result.current.loading).toBe(false);
    expect(result.current.currentMethod).toBe("none");

    // Positive companion: the fixture records B's requests, and the next step reads from B.
    act(() => {
      result.current.handleMethodSelect("code");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requestsTo(SERVER_B, GET_VERIFY)).toHaveLength(1);
    expect(requestsTo(SERVER_B, PUT_VERIFY)).toEqual([]);
    expect(result.current.currentMethod).toBe("pattern");
  });

  it("drops a successful save's reply when other reads landed while it was in flight, even back on its server", async () => {
    const { apiClient, result } = await mountOnServerA();
    expect(result.current.currentMethod).toBe("none");

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handleSave("code");
    });
    await vi.waitFor(
      () => expect(requestsTo(SERVER_A, PUT_VERIFY)).toHaveLength(1),
      { timeout: 5000, interval: 5 },
    );
    apiClient.setEndpoint(SERVER_C);
    act(() => {
      result.current.handleMethodSelect("pin");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requestsTo(SERVER_C, GET_VERIFY)).toHaveLength(1);
    expect(result.current.currentMethod).toBe("none");

    // Back on A, with the method read from A again: only the reads in between differ from the pin.
    apiClient.setEndpoint(SERVER_A);
    act(() => {
      result.current.handleMethodSelect("pin");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requestsTo(SERVER_A, GET_VERIFY)).toHaveLength(2);
    expect(result.current.currentMethod).toBe("none");

    // Neither the save's own method nor the earlier reads', so only a re-read from A explains it.
    methods.set(SERVER_A, "pattern");
    releasePut(CODE_SAVED);
    await act(async () => {
      await pending;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.saveState).toBe("error");
    expect(requestsTo(SERVER_A, GET_VERIFY)).toHaveLength(3);
    expect(result.current.currentMethod).toBe("pattern");
    expect(received.map(({ server, route }) => ({ server, route }))).toEqual([
      { server: SERVER_A, route: GET_VERIFY },
      { server: SERVER_A, route: PUT_VERIFY },
      { server: SERVER_C, route: GET_VERIFY },
      { server: SERVER_A, route: GET_VERIFY },
      { server: SERVER_A, route: GET_VERIFY },
    ]);
    expect(JSON.parse(requestsTo(SERVER_A, PUT_VERIFY)[0].body ?? "")).toEqual({
      method: "code",
    });
    expect(received.filter((r) => r.body?.includes("currentSecret"))).toEqual(
      [],
    );
  });

  it("drops a refused save's late re-read when another read landed first", async () => {
    methods.set(SERVER_A, "pin");
    const { apiClient, result } = await mountOnServerA();

    act(() => {
      result.current.handleMethodSelect("code");
    });
    expect(result.current.askingSecret).toBe(true);
    act(() => {
      result.current.handleCurrentSecret("1234");
    });
    await vi.waitFor(
      () => expect(requestsTo(SERVER_A, PUT_VERIFY)).toHaveLength(1),
      { timeout: 5000, interval: 5 },
    );
    holdServerAGet();
    releasePut(SECRET_REQUIRED);
    await waitFor(
      () => expect(requestsTo(SERVER_A, GET_VERIFY)).toHaveLength(2),
      { timeout: 5000, interval: 5 },
    );

    apiClient.setEndpoint(SERVER_B);
    act(() => {
      result.current.handleMethodSelect("code");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requestsTo(SERVER_B, GET_VERIFY)).toHaveLength(1);
    expect(result.current.currentMethod).toBe("none");

    releaseGet();
    // The late re-read's step is dropped and the method is read from B once more.
    await waitFor(
      () => expect(requestsTo(SERVER_B, GET_VERIFY)).toHaveLength(2),
      { timeout: 5000, interval: 5 },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.currentMethod).toBe("none");
    expect(result.current.askingSecret).toBe(false);
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.currentSecret).toBeUndefined();

    putReply = Promise.resolve(CODE_SAVED);
    act(() => {
      result.current.handleMethodSelect("code");
    });
    await waitFor(() => expect(result.current.saveState).toBe("saved"));

    const putsToB = requestsTo(SERVER_B, PUT_VERIFY);
    expect(putsToB).toHaveLength(1);
    expect(JSON.parse(putsToB[0].body ?? "")).toEqual({ method: "code" });
    expect(putsToB[0].body).not.toContain("1234");
    expect(requestsTo(SERVER_A, PUT_VERIFY)).toHaveLength(1);
    // Positive companion: the secret did reach the server the method was read from.
    expect(JSON.parse(requestsTo(SERVER_A, PUT_VERIFY)[0].body ?? "")).toEqual({
      method: "code",
      currentSecret: "1234",
    });
  });

  it("asks nothing and sends no secret when the server differs before a method is picked", async () => {
    methods.set(SERVER_A, "pin");
    const { apiClient, result } = await mountOnServerA();
    expect(result.current.currentMethod).toBe("pin");

    apiClient.setEndpoint(SERVER_B);
    act(() => {
      result.current.handleMethodSelect("code");
    });
    expect(result.current.askingSecret).toBe(false);
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    act(() => {
      result.current.handleCurrentSecret("1234");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const toB = received.filter((r) => r.server === SERVER_B);
    expect(requestsTo(SERVER_B, GET_VERIFY).length).toBeGreaterThanOrEqual(1);
    expect(requestsTo(SERVER_B, PUT_VERIFY)).toEqual([]);
    expect(toB.filter((r) => r.body?.includes("1234"))).toEqual([]);
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.saveState).toBe("error");
    expect(result.current.currentMethod).toBe("none");
    expect(result.current.askingSecret).toBe(false);
    expect(result.current.currentSecret).toBeUndefined();
    expect(result.current.selectedMethod).toBeNull();
  });

  it("sends no secret when the server differs while the current secret is asked for", async () => {
    methods.set(SERVER_A, "pin");
    const { apiClient, result } = await mountOnServerA();

    act(() => {
      result.current.handleMethodSelect("code");
    });
    expect(result.current.askingSecret).toBe(true);
    apiClient.setEndpoint(SERVER_B);
    act(() => {
      result.current.handleCurrentSecret("1234");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(requestsTo(SERVER_B, GET_VERIFY).length).toBeGreaterThanOrEqual(1);
    expect(requestsTo(SERVER_B, PUT_VERIFY)).toEqual([]);
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.currentSecret).toBeUndefined();
    expect(result.current.askingSecret).toBe(false);
  });

  // A PIN / pattern target has no handleSave backstop: only handleCurrentSecret's own check stops the setup step.
  it("opens no setup step when the server differs while the current secret is asked for", async () => {
    methods.set(SERVER_A, "pin");
    const { apiClient, result } = await mountOnServerA();
    act(() => {
      result.current.handleMethodSelect("pattern");
    });
    expect(result.current.askingSecret).toBe(true);
    apiClient.setEndpoint(SERVER_B);
    act(() => {
      result.current.handleCurrentSecret("1234");
    });
    expect(result.current.showSetup).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentSecret).toBeUndefined();
  });

  it("saves nothing on either server when the server differs before the save", async () => {
    methods.set(SERVER_A, "pin");
    const { apiClient, result } = await mountOnServerA();

    act(() => {
      result.current.handleMethodSelect("pin");
    });
    act(() => {
      result.current.handleCurrentSecret("1234");
    });
    expect(result.current.showSetup).toBe(true);
    apiClient.setEndpoint(SERVER_B);
    act(() => {
      void result.current.handleSave("pin", "5678", "1234");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(requestsTo(SERVER_B, GET_VERIFY).length).toBeGreaterThanOrEqual(1);
    expect(requestsTo(SERVER_A, PUT_VERIFY)).toEqual([]);
    expect(requestsTo(SERVER_B, PUT_VERIFY)).toEqual([]);
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.saveState).toBe("error");
    expect(result.current.showSetup).toBe(false);
    expect(result.current.selectedMethod).toBeNull();
    expect(result.current.currentSecret).toBeUndefined();
  });

  it("drops a read whose server changed before it landed and reads the current server", async () => {
    methods.set(SERVER_A, "pin");
    methods.set(SERVER_B, "pattern");
    holdServerAGet();
    const apiClient = new ApiClient(SERVER_A);
    apiClient.setAuthToken(TOKEN);
    const { result } = renderHook(() =>
      useVerifyMethodFlow({ userId: USER_ID, apiClient }),
    );
    await vi.waitFor(
      () => expect(requestsTo(SERVER_A, GET_VERIFY)).toHaveLength(1),
      { timeout: 5000, interval: 5 },
    );

    apiClient.setEndpoint(SERVER_B);
    releaseGet();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.currentMethod).toBe("pattern");
    expect(requestsTo(SERVER_A, GET_VERIFY)).toHaveLength(1);
    expect(requestsTo(SERVER_B, GET_VERIFY)).toHaveLength(1);
  });
});
