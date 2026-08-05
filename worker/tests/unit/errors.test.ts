import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { jsonError } from "../../src/utils/errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const testApp = new Hono();

// Legacy call shape — no options argument at all.
testApp.get("/plain", (c) =>
  jsonError(c, 403, "VERIFICATION_REQUIRED", "此帳號需要驗證才能登入"),
);

// Call shape used by the join handler: an options object whose `retryAfter`
// is undefined for every error except VERIFICATION_LOCKED.
testApp.get("/optional", (c) => {
  const raw = c.req.query("retryAfter");
  const retryAfter = raw === undefined ? undefined : Number(raw);
  return jsonError(c, 429, "VERIFICATION_LOCKED", "驗證已鎖定，請稍後再試", {
    retryAfter,
  });
});

describe("jsonError", () => {
  it("should return the bare code/message envelope when no options are passed", async () => {
    const res = await testApp.request("/plain");

    expect(res.status).toBe(403);
    expect(res.headers.get("Retry-After")).toBeNull();

    const json = (await res.json()) as Json;
    expect(json).toEqual({
      error: {
        code: "VERIFICATION_REQUIRED",
        message: "此帳號需要驗證才能登入",
      },
    });
    expect(Object.keys(json.error).sort()).toEqual(["code", "message"]);
  });

  it("should treat an explicitly undefined retryAfter as omitted", async () => {
    const res = await testApp.request("/optional");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeNull();

    const json = (await res.json()) as Json;
    expect(json).toEqual({
      error: {
        code: "VERIFICATION_LOCKED",
        message: "驗證已鎖定，請稍後再試",
      },
    });
    expect("retryAfter" in json.error).toBe(false);
  });

  it.each([1, 2, 42, 900])(
    "should expose retryAfter=%i in both the body and the Retry-After header",
    async (seconds) => {
      const res = await testApp.request(`/optional?retryAfter=${seconds}`);

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe(String(seconds));

      const json = (await res.json()) as Json;
      expect(json.error.retryAfter).toBe(seconds);
      expect(json.error.code).toBe("VERIFICATION_LOCKED");
      expect(json.error.message).toBe("驗證已鎖定，請稍後再試");
      expect(json.error.retryAfter).toBe(
        Number(res.headers.get("Retry-After")),
      );
    },
  );
});
