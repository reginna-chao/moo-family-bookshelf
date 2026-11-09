import { describe, it, expect } from "vitest";
import { currentSecretBody } from "moo-family-bookshelf-shared/api/currentSecretBody";

/**
 * currentSecretBody — the `{ currentSecret }` body of a self-leave and an ownership transfer, shared by
 * both clients. `shared/` has no test script, so the helper is pinned here. No secret means no body
 * (`undefined`), so a leave from a none account still goes out as a bodyless DELETE and a transfer's
 * spread adds no key. The request shapes are pinned in `extension/tests/unit/client.test.ts` and the
 * PWA client tests.
 */

describe("currentSecretBody", () => {
  it.each<[string, string | undefined, object | undefined]>([
    ["no secret", undefined, undefined],
    ["a PIN", "482913", { currentSecret: "482913" }],
    ["a pattern", "0,3,6,7", { currentSecret: "0,3,6,7" }],
  ])("builds the body for %s", (_label, secret, expected) => {
    expect(currentSecretBody(secret)).toStrictEqual(expected);
  });

  it("adds no key when spread without a secret", () => {
    expect({ userId: "u1", ...currentSecretBody(undefined) }).toStrictEqual({
      userId: "u1",
    });
  });
});
