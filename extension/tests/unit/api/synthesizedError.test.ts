import { describe, it, expect } from "vitest";
import { isClientSynthesized, synthesizeError } from "@/api/synthesizedError";

/**
 * `api/synthesizedError.ts`: the provenance marker on client-built error
 * envelopes (moved out of `api/client.ts`). Only `synthesizeError` output is
 * recognised; a server payload — anything that came through `JSON.parse` —
 * can carry the same code and message but never the symbol key, so it is not.
 * The client paths that use it are covered in tests/unit/client.test.ts.
 */

describe("synthesizeError / isClientSynthesized", () => {
  it("builds a payload with the given code and message that is recognised as client-built", () => {
    const payload = synthesizeError("AUTH_REFRESH_RATE_LIMITED", "請稍候");

    expect(payload).toMatchObject({
      code: "AUTH_REFRESH_RATE_LIMITED",
      message: "請稍候",
    });
    expect(isClientSynthesized(payload)).toBe(true);
  });

  it("does not recognise a look-alike server payload", () => {
    const fromServer = JSON.parse(
      '{"code":"AUTH_REFRESH_RATE_LIMITED","message":"請稍候","synthesized":true}',
    ) as { code: string; message: string };

    expect(isClientSynthesized(fromServer)).toBe(false);
  });

  it("does not survive a JSON round trip", () => {
    const roundTripped = JSON.parse(
      JSON.stringify(synthesizeError("X", "y")),
    ) as { code: string; message: string };

    expect(roundTripped).toEqual({ code: "X", message: "y" });
    expect(isClientSynthesized(roundTripped)).toBe(false);
  });
});
