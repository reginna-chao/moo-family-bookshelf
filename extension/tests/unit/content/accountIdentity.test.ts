import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { compareAccountIdentity } from "@/content/accountIdentity";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";

/**
 * compareAccountIdentity (issue #271) decides whether the Readmoo account on
 * the page owns the stored userId. It runs the REAL deriveUserId, so a change to
 * the hashing that silently broke every existing user's identity shows up here.
 */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const STORED_EMAIL = "owner@example.com";

describe("compareAccountIdentity", () => {
  let storedUserId: string;

  beforeAll(async () => {
    storedUserId = await deriveUserId(STORED_EMAIL);
  });

  it.each<[string, string | null, "match" | "mismatch" | "unknown"]>([
    ["the stored account's own email", STORED_EMAIL, "match"],
    // deriveUserId normalizes case and surrounding whitespace.
    ["the same email in other case / padding", "  Owner@Example.COM ", "match"],
    ["a different account's email", "someone-else@example.com", "mismatch"],
    ["no email (logged out / profile not rendered)", null, "unknown"],
    ["an empty email", "", "unknown"],
  ])("returns the verdict for %s", async (_label, email, expected) => {
    await expect(compareAccountIdentity(email, storedUserId)).resolves.toBe(
      expected,
    );
  });

  it("never reports a match against a userId no email derives to", async () => {
    await expect(
      compareAccountIdentity(STORED_EMAIL, "f".repeat(64)),
    ).resolves.toBe("mismatch");
  });
});
