import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { sha256Hex, deriveUserId } from "@/crypto/hash";

// Polyfill Web Crypto API for Node/jsdom test environment
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

describe("sha256Hex", () => {
  it("should return a 64-character hex string", async () => {
    const hash = await sha256Hex("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should return the correct SHA-256 for known input", async () => {
    // SHA-256 of "hello" (lowercase)
    const expected =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const hash = await sha256Hex("hello");
    expect(hash).toBe(expected);
  });

  it("should be case-insensitive (lowercases input before hashing)", async () => {
    const hash1 = await sha256Hex("Hello");
    const hash2 = await sha256Hex("hello");
    const hash3 = await sha256Hex("HELLO");
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it("should trim whitespace before hashing", async () => {
    const hash1 = await sha256Hex("hello");
    const hash2 = await sha256Hex("  hello  ");
    const hash3 = await sha256Hex("\thello\n");
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it("should be deterministic (same input always produces same output)", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sha256Hex("deterministic")),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it("should produce different hashes for different inputs", async () => {
    const hash1 = await sha256Hex("alice");
    const hash2 = await sha256Hex("bob");
    expect(hash1).not.toBe(hash2);
  });

  // Cross-platform test vectors: these exact values MUST match in both
  // Extension and PWA tests. If a test fails here, the other platform's
  // userId derivation is out of sync — do NOT change the expected values.
  it.each([
    [
      "test@example.com",
      "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b",
    ],
    [
      "Alice@Readmoo.COM",
      "19cfc819633f935f1286e5b0f142cbf8108f6e2f94ea3d58db690043fbc5c281",
    ],
    [
      "  User@Example.com  ",
      "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514",
    ],
  ])("cross-platform vector: sha256Hex(%j) = %s", async (input, expected) => {
    expect(await sha256Hex(input)).toBe(expected);
  });
});

describe("deriveUserId", () => {
  it("should hash email with 'moo:' prefix using SHA-256", async () => {
    const email = "alice@example.com";
    const derived = await deriveUserId(email);
    // deriveUserId(email) should equal sha256Hex("moo:" + email)
    const expected = await sha256Hex(`moo:${email}`);
    expect(derived).toBe(expected);
  });

  it("should be deterministic (same email produces same userId)", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => deriveUserId("bob@example.com")),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it("should produce different userIds for different emails", async () => {
    const id1 = await deriveUserId("alice@example.com");
    const id2 = await deriveUserId("bob@example.com");
    expect(id1).not.toBe(id2);
  });

  it("should return a lowercase hex string of 64 characters (SHA-256)", async () => {
    const id = await deriveUserId("test@example.com");
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  // Cross-platform test vectors: these exact values MUST match in both
  // Extension and PWA tests. If a test fails here, the other platform's
  // userId derivation is out of sync — do NOT change the expected values.
  it.each([
    [
      "test@example.com",
      "e1c3d577b4d43fae376a7d6c504020cfd43f8f51c48bb97c9ca64361ab1fe540",
    ],
    [
      "Alice@Readmoo.COM",
      "3f29ef58c6ada4d69fb047baa40ff2e34708a90047d3de933cc02a9d90ea17aa",
    ],
    [
      "  User@Example.com  ",
      "89f7e39cc90a4bf90502af2f6862d07bcd3dbe9f08cb6dcc96e8a0fd1f404da1",
    ],
  ])(
    "cross-platform vector: deriveUserId(%j) = %s",
    async (input, expected) => {
      expect(await deriveUserId(input)).toBe(expected);
    },
  );
});
