import { HTTPException } from "hono/http-exception";
import { describe, it, expect, vi } from "vitest";
import {
  summarizeErrorForLog,
  type SafeErrorSummary,
} from "../../src/utils/errorLog";
import { kvKeys } from "../../src/kv/schema";
import { USER1 } from "../helpers/ids";

/**
 * `summarizeErrorForLog` (`src/utils/errorLog.ts`, #480) — the only form a
 * caught error may take in a Worker `console.*` call.
 *
 * What it may return, and nothing else: an allowlisted type name, the KV
 * operation + 3-digit status of a workerd `KV <op> failed: <status> …`
 * message, and an `HTTPException`'s integer status. Never the message, the
 * stack or the cause — those are where a KV key (which embeds a userId /
 * familyId / token hash / IP), or a fragment of a stored value (a corrupt-JSON
 * `SyntaxError`), would ride into the log.
 *
 * Every case that feeds identifiers in pins the summary with an exact
 * `toEqual`; the `leaks()` check beside most of them is a second, readable
 * guard (the exact equality is what keeps it from passing on an empty object).
 *
 * Name allowlist (stricter than a literal reading of #480): ONLY the nine
 * built-in names pass through from `err.name`. The
 * three synthetic names are never read from it — `"HTTPException"` comes from
 * `instanceof HTTPException` alone, so a plain Error renamed `"HTTPException"`,
 * `"Other"` or `"NonError"` summarizes as `"Other"`. `httpStatus` is present
 * only when `.status` is an integer.
 *
 * Never throws: a throwing `name` / `message` getter, a Proxy whose
 * `getPrototypeOf` trap throws (`instanceof` walks it) and a revoked Proxy all
 * summarize as `{ name: "Other" }`. A non-string `message` is neither matched
 * nor stringified, so a caller-controlled `toString` never runs.
 */

/** Identifiers a KV error tail could carry; none may survive into a summary. */
const TOKEN_HASH = "9f".repeat(32);
const CALLER_IP = "203.0.113.77";
const FAMILY_ID = "abcd-1234";
const SENTINELS = [USER1, TOKEN_HASH, CALLER_IP, FAMILY_ID];

/** Sentinels found anywhere in the serialized summary (expected: none). */
function leaks(summary: SafeErrorSummary, sentinels = SENTINELS): string[] {
  const text = JSON.stringify(summary);
  return sentinels.filter((s) => text.includes(s));
}

describe("summarizeErrorForLog — workerd KV failures", () => {
  it.each([
    [
      "GET",
      503,
      `KV GET failed: 503 Service Unavailable ${kvKeys.user(USER1)}`,
    ],
    [
      "GET_BULK",
      413,
      `KV GET_BULK failed: 413 Payload Too Large ${kvKeys.family(FAMILY_ID)}`,
    ],
    [
      "PUT",
      500,
      `KV PUT failed: 500 Internal Server Error ${kvKeys.authToken(TOKEN_HASH)}`,
    ],
    [
      "DELETE",
      429,
      `KV DELETE failed: 429 Too Many Requests ${kvKeys.verifyFail(USER1, CALLER_IP)}`,
    ],
    // list() failures report GET in workerd's own text.
    ["GET", 400, `KV GET failed: 400 Bad Request tokenidx:${USER1}:`],
    // Status with no tail at all.
    ["PUT", 503, "KV PUT failed: 503"],
  ] as const)(
    "keeps only op %s and status %i from the message",
    (kvOp, kvStatus, message) => {
      const summary = summarizeErrorForLog(new Error(message));

      expect(summary).toEqual({ name: "Error", kvOp, kvStatus });
      expect(leaks(summary)).toEqual([]);
    },
  );

  it("keeps an allowlisted subclass name beside the KV fields", () => {
    const err = new TypeError(`KV PUT failed: 413 Value too large ${USER1}`);

    expect(summarizeErrorForLog(err)).toEqual({
      name: "TypeError",
      kvOp: "PUT",
      kvStatus: 413,
    });
  });

  it("never carries the message, stack or cause", () => {
    const err = new Error(
      `KV GET failed: 503 Service Unavailable ${kvKeys.user(USER1)}`,
      { cause: new Error(`cause ${TOKEN_HASH}`) },
    );
    // Positive companion: the raw error DOES carry every sentinel.
    expect(String(err.stack)).toContain(USER1);
    expect((err.cause as Error).message).toContain(TOKEN_HASH);

    const summary = summarizeErrorForLog(err);

    expect(Object.keys(summary).sort()).toEqual(["kvOp", "kvStatus", "name"]);
    expect(leaks(summary)).toEqual([]);
  });

  it.each([
    ["a prefix before KV", `xKV GET failed: 500 ${USER1}`],
    ["a leading space", ` KV GET failed: 500 ${USER1}`],
    ["a stringified Error prefix", `Error: KV GET failed: 503 ${USER1}`],
    ["a 4-digit status", `KV GET failed: 5000 ${USER1}`],
    ["a 2-digit status", `KV GET failed: 50 ${USER1}`],
    ["no space before the status", `KV GET failed:503 ${USER1}`],
    ["an unknown op", `KV LIST failed: 500 ${USER1}`],
    ["a lower-case prefix", `kv get failed: 500 ${USER1}`],
    ["an empty message", ""],
  ])("adds no KV fields for %s", (_label, message) => {
    const summary = summarizeErrorForLog(new Error(message));

    expect(summary).toEqual({ name: "Error" });
    expect(leaks(summary)).toEqual([]);
  });
});

describe("summarizeErrorForLog — corrupt JSON value", () => {
  it("logs a SyntaxError by name only, dropping the echoed value fragment", () => {
    const stored = `user-${USER1}`; // a non-JSON value under kv.get(key, "json")
    let err: unknown;
    try {
      JSON.parse(stored);
    } catch (caught) {
      err = caught;
    }
    // Positive companion: the parser's own message echoes the value.
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toContain("user-");

    const summary = summarizeErrorForLog(err);

    expect(summary).toEqual({ name: "SyntaxError" });
    expect(leaks(summary, [USER1, "user-"])).toEqual([]);
  });
});

describe("summarizeErrorForLog — type names", () => {
  it.each([
    ["Error", new Error("m")],
    ["TypeError", new TypeError("m")],
    ["SyntaxError", new SyntaxError("m")],
    ["RangeError", new RangeError("m")],
    ["ReferenceError", new ReferenceError("m")],
    ["EvalError", new EvalError("m")],
    ["URIError", new URIError("m")],
    ["AggregateError", new AggregateError([], "m")],
    ["DOMException", Object.assign(new Error("m"), { name: "DOMException" })],
  ] as const)("passes the built-in name %s through", (name, err) => {
    expect(summarizeErrorForLog(err)).toEqual({ name });
  });

  it.each([
    ["HTTPException", "HTTPException"],
    ["Other", "Other"],
    ["NonError", "NonError"],
    ["an id", `user:${USER1}`],
    ["a near miss", "TypeError "],
    ["an empty string", ""],
    ["a DOMException subtype", "AbortError"],
  ])("maps a name spoofed as %s to Other", (_label, name) => {
    const err = Object.assign(new Error("m"), { name });

    const summary = summarizeErrorForLog(err);

    expect(summary).toEqual({ name: "Other" });
    expect(leaks(summary)).toEqual([]);
  });

  it("maps a custom subclass name to Other", () => {
    class KvKeyError extends Error {
      override name = `KvKeyError ${FAMILY_ID}`;
    }

    expect(summarizeErrorForLog(new KvKeyError("m"))).toEqual({
      name: "Other",
    });
  });

  it("maps a non-string name to Other", () => {
    const err = Object.assign(new Error("m"), { name: 42 });

    expect(summarizeErrorForLog(err)).toEqual({ name: "Other" });
  });
});

describe("summarizeErrorForLog — non-Error throws", () => {
  it.each([
    ["a string", `KV GET failed: 503 ${kvKeys.user(USER1)}`],
    [
      "an Error-shaped object",
      {
        name: "Error",
        message: `KV GET failed: 503 ${kvKeys.user(USER1)}`,
        stack: `Error: ${USER1}`,
      },
    ],
    ["null", null],
    ["undefined", undefined],
    ["a number", 503],
  ])("summarizes %s as NonError", (_label, thrown) => {
    const summary = summarizeErrorForLog(thrown);

    expect(summary).toEqual({ name: "NonError" });
    expect(leaks(summary)).toEqual([]);
  });
});

describe("summarizeErrorForLog — HTTPException", () => {
  it.each([500, 503])("keeps the integer status %i only", (status) => {
    const err = new HTTPException(status as 500, {
      message: `KV GET failed: 503 ${kvKeys.user(USER1)}`,
    });

    const summary = summarizeErrorForLog(err);

    // No kvOp / kvStatus: an HTTPException's message is never matched.
    expect(summary).toEqual({ name: "HTTPException", httpStatus: status });
    expect(leaks(summary)).toEqual([]);
  });

  it.each([
    ["a fractional status", 503.5],
    ["a string status", "503"],
    ["a NaN status", Number.NaN],
  ])("drops %s", (_label, status) => {
    const err = new HTTPException(503);
    Object.defineProperty(err, "status", { value: status });

    expect(summarizeErrorForLog(err)).toEqual({ name: "HTTPException" });
  });
});

describe("summarizeErrorForLog — never throws", () => {
  it("answers Other when the name getter throws", () => {
    class TrappedName extends Error {
      override get name(): string {
        throw new Error(`getter ${USER1}`);
      }
    }

    expect(summarizeErrorForLog(new TrappedName("m"))).toEqual({
      name: "Other",
    });
  });

  it("answers Other when the message getter throws", () => {
    const err = new Error("m");
    Object.defineProperty(err, "message", {
      get() {
        throw new Error(`getter ${USER1}`);
      },
    });

    expect(summarizeErrorForLog(err)).toEqual({ name: "Other" });
  });

  it("answers Other when instanceof hits a throwing getPrototypeOf trap", () => {
    const err = new Proxy(new Error("m"), {
      getPrototypeOf() {
        throw new Error(`trap ${USER1}`);
      },
    });

    expect(summarizeErrorForLog(err)).toEqual({ name: "Other" });
  });

  it("answers Other for a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable(new Error("m"), {});
    revoke();

    expect(summarizeErrorForLog(proxy)).toEqual({ name: "Other" });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error(`toString ${USER1}`);
      },
    ],
    ["returns a KV message", () => `KV GET failed: 503 ${USER1}`],
  ])("never calls a non-string message's toString that %s", (_label, impl) => {
    const toString = vi.fn(impl);
    const err = new Error("m");
    Object.defineProperty(err, "message", { value: { toString } });

    const summary = summarizeErrorForLog(err);

    expect(summary).toEqual({ name: "Error" });
    expect(toString).not.toHaveBeenCalled();
  });
});
