import { describe, it, expect } from "vitest";
import { isClientSynthesized } from "@/api/synthesizedError";
import { AUTH_REFRESH_RATE_LIMITED, type ApiResponse } from "@/api/types";
import {
  rateLimitedFailure,
  unauthorizedFailure,
} from "@/api/unauthorizedResponse";

const GENERIC_401 = { code: "UNAUTHORIZED", message: "Authentication failed" };

describe("unauthorizedFailure", () => {
  const CASES: Array<{
    name: string;
    envelope: ApiResponse<unknown>;
    expected: { code: string; message: string; retryAfter?: number };
  }> = [
    {
      name: "passes the server's own error through",
      envelope: { error: { code: "TOKEN_EXPIRED", message: "expired" } },
      expected: { code: "TOKEN_EXPIRED", message: "expired" },
    },
    {
      name: "keeps every field of the server's error",
      envelope: { error: { code: "X", message: "y", retryAfter: 30 } },
      expected: { code: "X", message: "y", retryAfter: 30 },
    },
    {
      name: "falls back to UNAUTHORIZED on an empty envelope",
      envelope: {},
      expected: GENERIC_401,
    },
    {
      name: "falls back to UNAUTHORIZED and drops data from an envelope with no error",
      envelope: { data: { books: [] } },
      expected: GENERIC_401,
    },
  ];

  it.each(CASES)("$name", ({ envelope, expected }) => {
    expect(unauthorizedFailure(envelope)).toEqual({ error: expected });
  });

  it("does not mark a server-sent rate-limit code as client-synthesized", () => {
    const { error } = unauthorizedFailure({
      error: { code: AUTH_REFRESH_RATE_LIMITED, message: "from the server" },
    });

    expect(error?.code).toBe(AUTH_REFRESH_RATE_LIMITED);
    expect(isClientSynthesized(error!)).toBe(false);
  });
});

describe("rateLimitedFailure", () => {
  const BASE_MESSAGE = "嘗試次數過多，請稍後再重新開啟書櫃";

  it("carries the rate-limit code on a client-synthesized error", () => {
    const { data, error } = rateLimitedFailure(undefined);

    expect(data).toBeUndefined();
    expect(error?.code).toBe(AUTH_REFRESH_RATE_LIMITED);
    expect(isClientSynthesized(error!)).toBe(true);
  });

  it("uses the base message when the cooldown end is unknown", () => {
    expect(rateLimitedFailure(undefined).error?.message).toBe(BASE_MESSAGE);
  });

  it("adds the remaining wait when the cooldown end is known", () => {
    const { error } = rateLimitedFailure(Date.now() + 90_000);

    expect(error?.message).toBe(`${BASE_MESSAGE}（約 2 分鐘後）`);
  });
});
