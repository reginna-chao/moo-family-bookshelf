import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKey,
  exportKey,
  importKey,
  encrypt,
  decrypt,
  sha256Hex,
  deriveUserId,
  bufferToBase62,
  base62ToBuffer,
} from "@/crypto/encrypt";

// Polyfill Web Crypto API for Node/jsdom test environment
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

describe("generateKey", () => {
  it("should return a CryptoKey", async () => {
    const key = await generateKey();
    expect(key).toBeDefined();
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  it("should return an extractable key", async () => {
    const key = await generateKey();
    expect(key.extractable).toBe(true);
  });

  it("should allow encrypt and decrypt usages", async () => {
    const key = await generateKey();
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });
});

describe("exportKey + importKey", () => {
  it("should roundtrip a key via export then import", async () => {
    const original = await generateKey();
    const encoded = await exportKey(original);
    const imported = await importKey(encoded);

    // Verify both keys produce the same encryption/decryption
    const plaintext = "roundtrip key test";
    const ciphertext = await encrypt(plaintext, original);
    const decrypted = await decrypt(ciphertext, imported);
    expect(decrypted).toBe(plaintext);
  });

  it("should export to a non-empty Base62 string", async () => {
    const key = await generateKey();
    const encoded = await exportKey(key);
    expect(encoded.length).toBeGreaterThan(0);
    // Base62 chars only
    expect(encoded).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("should import a key with correct algorithm properties", async () => {
    const original = await generateKey();
    const encoded = await exportKey(original);
    const imported = await importKey(encoded);
    expect(imported.algorithm).toMatchObject({ name: "AES-GCM" });
    expect(imported.extractable).toBe(true);
    expect(imported.usages).toContain("encrypt");
    expect(imported.usages).toContain("decrypt");
  });
});

describe("encrypt + decrypt", () => {
  it("should roundtrip a simple string", async () => {
    const key = await generateKey();
    const plaintext = "Hello, World!";
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce different ciphertext each time due to random IV", async () => {
    const key = await generateKey();
    const plaintext = "same input";
    const c1 = await encrypt(plaintext, key);
    const c2 = await encrypt(plaintext, key);
    expect(c1).not.toBe(c2);
  });

  it("should fail to decrypt with a different key", async () => {
    const key1 = await generateKey();
    const key2 = await generateKey();
    const ciphertext = await encrypt("secret", key1);
    await expect(decrypt(ciphertext, key2)).rejects.toThrow();
  });

  it("should handle empty string", async () => {
    const key = await generateKey();
    const ciphertext = await encrypt("", key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe("");
  });

  it("should handle unicode and Chinese characters", async () => {
    const key = await generateKey();
    const plaintext = "家庭書架 📚 — Moo Family Bookshelf 繁體中文";
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should handle a large payload", async () => {
    const key = await generateKey();
    const plaintext = "a".repeat(100_000);
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce Base64-encoded ciphertext", async () => {
    const key = await generateKey();
    const ciphertext = await encrypt("test", key);
    // Base64 characters: A-Z, a-z, 0-9, +, /, =
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("should fail to decrypt tampered ciphertext", async () => {
    const key = await generateKey();
    const ciphertext = await encrypt("original", key);
    // Flip a character in the middle of the ciphertext
    const mid = Math.floor(ciphertext.length / 2);
    const tampered =
      ciphertext.slice(0, mid) +
      (ciphertext[mid] === "A" ? "B" : "A") +
      ciphertext.slice(mid + 1);
    await expect(decrypt(tampered, key)).rejects.toThrow();
  });
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

describe("bufferToBase62", () => {
  it("should encode an empty buffer as '0'", () => {
    const buffer = new Uint8Array([]).buffer;
    expect(bufferToBase62(buffer)).toBe("0");
  });

  it("should encode a single zero byte as '0'", () => {
    const buffer = new Uint8Array([0]).buffer;
    expect(bufferToBase62(buffer)).toBe("0");
  });

  it("should encode a single non-zero byte", () => {
    const buffer = new Uint8Array([255]).buffer;
    const result = bufferToBase62(buffer);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("should encode a larger buffer to Base62 characters only", () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const result = bufferToBase62(buffer);
    expect(result).toMatch(/^[0-9A-Za-z]+$/);
  });
});

describe("base62ToBuffer", () => {
  it("should decode '0' to a buffer", () => {
    const buffer = base62ToBuffer("0");
    const bytes = new Uint8Array(buffer);
    // '0' decodes to value 0, which is a single zero byte
    expect(bytes.length).toBeGreaterThanOrEqual(1);
    expect(bytes[0]).toBe(0);
  });

  it("should throw on invalid Base62 characters", () => {
    expect(() => base62ToBuffer("hello!")).toThrow("Invalid Base62 character");
    expect(() => base62ToBuffer("abc#def")).toThrow("Invalid Base62 character");
    expect(() => base62ToBuffer("test$")).toThrow("Invalid Base62 character");
  });
});

describe("bufferToBase62 + base62ToBuffer roundtrip", () => {
  it("should roundtrip a known byte array", () => {
    const original = new Uint8Array([10, 20, 30, 40, 50]);
    const encoded = bufferToBase62(original.buffer);
    const decoded = new Uint8Array(base62ToBuffer(encoded));

    // The decoded buffer should represent the same numeric value
    // (leading zeros may be lost since BigInt doesn't preserve them)
    const originalValue = original.reduce(
      (acc, b) => (acc << 8n) | BigInt(b),
      0n,
    );
    const decodedValue = decoded.reduce(
      (acc, b) => (acc << 8n) | BigInt(b),
      0n,
    );
    expect(decodedValue).toBe(originalValue);
  });

  it("should roundtrip via exportKey/importKey (32 byte key)", async () => {
    const key = await generateKey();
    const exported = await exportKey(key);
    const reimported = await importKey(exported);

    // Verify functional equivalence
    const plaintext = "key roundtrip via Base62";
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, reimported);
    expect(decrypted).toBe(plaintext);
  });

  it("should roundtrip single byte values", () => {
    for (const byte of [1, 61, 62, 127, 255]) {
      const original = new Uint8Array([byte]);
      const encoded = bufferToBase62(original.buffer);
      const decoded = new Uint8Array(base62ToBuffer(encoded));
      const originalVal = BigInt(byte);
      const decodedVal = decoded.reduce(
        (acc, b) => (acc << 8n) | BigInt(b),
        0n,
      );
      expect(decodedVal).toBe(originalVal);
    }
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
  ])("cross-platform vector: deriveUserId(%j) = %s", async (input, expected) => {
    expect(await deriveUserId(input)).toBe(expected);
  });
});
