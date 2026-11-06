import { vi } from "vitest";

export interface Call {
  origin: string;
  path: string;
  method: string;
  body: string | undefined;
  token: string | undefined;
}

export interface Reply {
  status: number;
  body: unknown;
}

export type Route = (call: Call) => Reply | Promise<Reply> | undefined;

export const ok = (data: unknown): Reply => ({ status: 200, body: { data } });

export const refused = (
  status: number,
  code: string,
  message: string = code,
): Reply => ({
  status,
  body: { error: { code, message } },
});

/** A response the test releases at the moment an interleaving calls for. */
export function held<T = Reply>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Replace `globalThis.fetch` and record every request with its origin and bearer
 * token, so an assertion can say which server saw which token. An unrouted request
 * is a plain 404, so it can never read as a success. The caller restores `fetch`.
 */
export function fakeNetwork(route: Route): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      origin: url.origin,
      path: url.pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      token: (
        init?.headers as Record<string, string> | undefined
      )?.Authorization?.replace("Bearer ", ""),
    };
    calls.push(call);
    const reply = (await route(call)) ?? refused(404, "NOT_FOUND");
    return {
      ok: reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

export const callsTo = (calls: Call[], server: string): Call[] =>
  calls.filter(({ origin }) => origin === server);

/** One macrotask: the fake network and the store answer in microtasks, so all that is not held has run. */
export async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
