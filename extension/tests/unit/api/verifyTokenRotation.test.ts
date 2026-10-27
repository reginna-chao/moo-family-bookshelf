import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { adoptRotatedVerifyToken } from "moo-family-bookshelf-shared/api/verifyTokenRotation";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";

/**
 * adoptRotatedVerifyToken (#378, `shared/src/api/verifyTokenRotation.ts`): the
 * `PUT /api/user/:id/verify` answer to a new pin / pattern / code carries the
 * replacement for the token the server just revoked. Both API clients hand it
 * to `setAuthToken` through `adopt`; the client-level behaviour (the next
 * request's `Authorization` header) is pinned in `verifyApi.test.ts` of each
 * app. This file pins the shared helper's own contract, which those tests reach
 * only through `fetch`: `adopt` runs only for a 64-char lowercase hex token,
 * a malformed token or expiry loses its key with one `[issuedCredentials]`
 * warn, and an error envelope or a missing / non-object `data` comes back as
 * the very same object without adopting anything.
 */

const ROTATED_TOKEN = "0123456789abcdef".repeat(4);
const ROTATED_EXPIRY = 1_700_000_000_000;
const WARN_PREFIX = /^\[issuedCredentials\]/;

describe("adoptRotatedVerifyToken", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("hands a valid token to adopt before returning and keeps every field", () => {
    const adopt = vi.fn();
    const res: ApiResponse<unknown> = {
      data: {
        method: "pin",
        prompted: 1,
        authToken: ROTATED_TOKEN,
        expiresAt: ROTATED_EXPIRY,
      },
    };

    const result = adoptRotatedVerifyToken(res, adopt);

    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith(ROTATED_TOKEN);
    expect(result).toStrictEqual({
      data: {
        method: "pin",
        prompted: 1,
        authToken: ROTATED_TOKEN,
        expiresAt: ROTATED_EXPIRY,
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("adopts nothing and stays silent when no token was issued", () => {
    const adopt = vi.fn();

    const result = adoptRotatedVerifyToken(
      { data: { method: "none", prompted: 1 } },
      adopt,
    );

    expect(adopt).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ data: { method: "none", prompted: 1 } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each<{ label: string; authToken: unknown }>([
    { label: "a short string", authToken: "abc" },
    { label: "upper-case hex", authToken: ROTATED_TOKEN.toUpperCase() },
    { label: "65 hex chars", authToken: `${ROTATED_TOKEN}0` },
    { label: "an empty string", authToken: "" },
    { label: "a number", authToken: 42 },
    { label: "null", authToken: null },
    { label: "an array", authToken: [ROTATED_TOKEN] },
  ])("drops $label as authToken without adopting it", ({ authToken }) => {
    const adopt = vi.fn();

    const result = adoptRotatedVerifyToken(
      { data: { method: "code", prompted: 1, authToken } },
      adopt,
    );

    expect(adopt).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ data: { method: "code", prompted: 1 } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(WARN_PREFIX);
  });

  it.each<{ label: string; expiresAt: unknown }>([
    { label: "a string", expiresAt: String(ROTATED_EXPIRY) },
    { label: "zero", expiresAt: 0 },
    { label: "NaN", expiresAt: Number.NaN },
    { label: "Infinity", expiresAt: Number.POSITIVE_INFINITY },
  ])("adopts a valid token but drops $label as expiresAt", ({ expiresAt }) => {
    const adopt = vi.fn();

    const result = adoptRotatedVerifyToken(
      {
        data: {
          method: "pattern",
          prompted: 1,
          authToken: ROTATED_TOKEN,
          expiresAt,
        },
      },
      adopt,
    );

    expect(adopt).toHaveBeenCalledWith(ROTATED_TOKEN);
    expect(result).toStrictEqual({
      data: { method: "pattern", prompted: 1, authToken: ROTATED_TOKEN },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an error envelope untouched even when its data carries a token", () => {
    const adopt = vi.fn();
    const res: ApiResponse<unknown> = {
      error: { code: "INVALID_METHOD", message: "Invalid method" },
      data: { method: "pin", authToken: ROTATED_TOKEN },
    };

    const result = adoptRotatedVerifyToken(res, adopt);

    expect(result).toBe(res);
    expect(adopt).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each<{ label: string; res: ApiResponse<unknown> }>([
    { label: "data: null", res: { data: null } },
    { label: "no data key", res: {} },
    { label: "a string as data", res: { data: ROTATED_TOKEN } },
    { label: "a number as data", res: { data: 1 } },
    {
      label: "an array as data",
      res: { data: [{ authToken: ROTATED_TOKEN }] },
    },
  ])("returns an envelope with $label untouched", ({ res }) => {
    const adopt = vi.fn();

    const result = adoptRotatedVerifyToken(res, adopt);

    expect(result).toBe(res);
    expect(adopt).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
