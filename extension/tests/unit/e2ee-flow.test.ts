import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKey,
  exportKey,
  importKey,
  encrypt,
  decrypt,
} from "@/crypto/encrypt";
import { encodeSyncCode, decodeSyncCode } from "@/crypto/syncCode";
import { mergeBooks } from "@/dialog/mergeBooks";
import type { BookEntry } from "@/api/client";
import type { ScrapedBook } from "@/content/scraper";

// Polyfill Web Crypto API for Node/jsdom test environment
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

// --- Helpers ---

function makeBookEntry(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: "book-001",
    title: "Test Book",
    author: "Test Author",
    isbn: "978-0000000000",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://mooink.readmoo.com/book/book-001",
    isShared: false,
    ...overrides,
  };
}

function makeScrapedBook(overrides: Partial<ScrapedBook> = {}): ScrapedBook {
  return {
    bookId: "book-001",
    title: "Test Book",
    author: "Test Author",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://mooink.readmoo.com/book/book-001",
    ...overrides,
  };
}

function makePersonalBooksJson(books: BookEntry[]): string {
  return JSON.stringify({
    userId: "user-abc",
    displayName: "Alice",
    books,
    lastUpdated: new Date().toISOString(),
  });
}

// --- Full personal books lifecycle ---

describe("Full personal books lifecycle", () => {
  it("should encrypt a book list, store ciphertext, then decrypt back to original", async () => {
    const books: BookEntry[] = [
      makeBookEntry({ bookId: "b1", title: "Book One" }),
      makeBookEntry({ bookId: "b2", title: "Book Two", isShared: true }),
    ];
    const plaintext = makePersonalBooksJson(books);

    const key = await generateKey();
    const ciphertext = await encrypt(plaintext, key);

    // Simulate storage: ciphertext is an opaque string
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext).not.toBe(plaintext);

    // Retrieve and decrypt
    const decrypted = await decrypt(ciphertext, key);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };
    expect(parsed.books).toHaveLength(2);
    expect(parsed.books[0].title).toBe("Book One");
    expect(parsed.books[1].isShared).toBe(true);
  });

  it("should preserve all BookEntry fields through the encrypt/decrypt cycle", async () => {
    const original = makeBookEntry({
      bookId: "210439468000101",
      title: "深度工作力",
      author: "乔尔·乔纳森",
      isbn: "978-9573280439",
      coverUrl: "https://example.com/deep-work.jpg",
      readmooUrl: "https://mooink.readmoo.com/book/210439468000101",
      isShared: true,
    });
    const plaintext = JSON.stringify(original);

    const key = await generateKey();
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    const restored = JSON.parse(decrypted) as BookEntry;

    expect(restored).toEqual(original);
  });

  it("should produce different ciphertext for identical data (random IV)", async () => {
    const books = [makeBookEntry()];
    const plaintext = makePersonalBooksJson(books);
    const key = await generateKey();

    const c1 = await encrypt(plaintext, key);
    const c2 = await encrypt(plaintext, key);

    expect(c1).not.toBe(c2);

    // Both should decrypt to the same content
    const d1 = await decrypt(c1, key);
    const d2 = await decrypt(c2, key);
    expect(d1).toBe(d2);
  });
});

// --- Sync code carries encryption key correctly ---

describe("Sync code carries encryption key correctly", () => {
  it("should roundtrip key through sync code encode/decode", async () => {
    const key = await generateKey();
    const exported = await exportKey(key);

    const syncCode = encodeSyncCode({
      familyId: "fam123",
      encryptionKey: exported,
    });
    const decoded = decodeSyncCode(syncCode);
    const reimportedKey = await importKey(decoded.encryptionKey);

    // Verify functional equivalence: encrypt with original, decrypt with reimported
    const plaintext = "sync code roundtrip test";
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, reimportedKey);
    expect(decrypted).toBe(plaintext);
  });

  it("should preserve familyId through sync code roundtrip", async () => {
    const key = await generateKey();
    const exported = await exportKey(key);
    const familyId = "myfamily2024";

    const syncCode = encodeSyncCode({
      familyId,
      encryptionKey: exported,
    });
    const decoded = decodeSyncCode(syncCode);

    expect(decoded.familyId).toBe(familyId);
  });

  it("should preserve custom API host through sync code roundtrip", async () => {
    const key = await generateKey();
    const exported = await exportKey(key);

    const syncCode = encodeSyncCode({
      familyId: "fam456",
      encryptionKey: exported,
      apiHost: "api.example.com",
    });
    const decoded = decodeSyncCode(syncCode);

    expect(decoded.apiHost).toBe("api.example.com");
    expect(decoded.familyId).toBe("fam456");

    // Key still works for crypto
    const reimportedKey = await importKey(decoded.encryptionKey);
    const ciphertext = await encrypt("custom host test", key);
    const decrypted = await decrypt(ciphertext, reimportedKey);
    expect(decrypted).toBe("custom host test");
  });
});

// --- Cross-user simulation ---

describe("Cross-user simulation", () => {
  it("should allow User B to decrypt User A's books using a shared sync code", async () => {
    // User A: generate key + encrypt book list
    const keyA = await generateKey();
    const exportedA = await exportKey(keyA);
    const familyId = "familyabc";

    const userABooks: BookEntry[] = [
      makeBookEntry({ bookId: "a1", title: "Alice's Book", isShared: true }),
      makeBookEntry({ bookId: "a2", title: "Alice's Private Book", isShared: false }),
    ];
    const userAPayload = makePersonalBooksJson(userABooks);
    const userACiphertext = await encrypt(userAPayload, keyA);

    // User A shares sync code with User B
    const syncCode = encodeSyncCode({
      familyId,
      encryptionKey: exportedA,
    });

    // User B: receives sync code, decodes, imports key
    const decoded = decodeSyncCode(syncCode);
    expect(decoded.familyId).toBe(familyId);

    const keyB = await importKey(decoded.encryptionKey);

    // User B can decrypt User A's encrypted payload
    const decrypted = await decrypt(userACiphertext, keyB);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };
    expect(parsed.books).toHaveLength(2);
    expect(parsed.books[0].title).toBe("Alice's Book");
    expect(parsed.books[0].isShared).toBe(true);
  });

  it("should allow User B to encrypt data that User A can decrypt", async () => {
    // Both users share the same key via sync code
    const originalKey = await generateKey();
    const exported = await exportKey(originalKey);
    const syncCode = encodeSyncCode({
      familyId: "sharedfamily",
      encryptionKey: exported,
    });

    // User A imports key
    const decodedA = decodeSyncCode(syncCode);
    const keyA = await importKey(decodedA.encryptionKey);

    // User B imports same key
    const decodedB = decodeSyncCode(syncCode);
    const keyB = await importKey(decodedB.encryptionKey);

    // User B encrypts
    const userBBooks = [makeBookEntry({ bookId: "b1", title: "Bob's Book" })];
    const userBPayload = makePersonalBooksJson(userBBooks);
    const userBCiphertext = await encrypt(userBPayload, keyB);

    // User A decrypts
    const decrypted = await decrypt(userBCiphertext, keyA);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };
    expect(parsed.books[0].title).toBe("Bob's Book");
  });

  it("should prevent a non-family member from decrypting data", async () => {
    const familyKey = await generateKey();
    const outsiderKey = await generateKey();

    const secret = makePersonalBooksJson([
      makeBookEntry({ bookId: "s1", title: "Secret Book" }),
    ]);
    const ciphertext = await encrypt(secret, familyKey);

    await expect(decrypt(ciphertext, outsiderKey)).rejects.toThrow();
  });
});

// --- mergeBooks logic ---

describe("mergeBooks", () => {
  it("should default new scraped books to isShared: false", () => {
    const scraped: ScrapedBook[] = [
      makeScrapedBook({ bookId: "new-1", title: "New Book" }),
    ];
    const saved: BookEntry[] = [];

    const merged = mergeBooks(scraped, saved);

    expect(merged).toHaveLength(1);
    expect(merged[0].bookId).toBe("new-1");
    expect(merged[0].isShared).toBe(false);
  });

  it("should keep isShared setting from saved books when merging", () => {
    const scraped: ScrapedBook[] = [
      makeScrapedBook({ bookId: "b1", title: "Updated Title" }),
    ];
    const saved: BookEntry[] = [
      makeBookEntry({ bookId: "b1", title: "Old Title", isShared: true }),
    ];

    const merged = mergeBooks(scraped, saved);

    expect(merged).toHaveLength(1);
    expect(merged[0].bookId).toBe("b1");
    expect(merged[0].title).toBe("Updated Title"); // scraped metadata wins
    expect(merged[0].isShared).toBe(true); // saved setting preserved
  });

  it("should preserve saved-only books that are not in scraped data", () => {
    const scraped: ScrapedBook[] = [
      makeScrapedBook({ bookId: "b1", title: "On Page" }),
    ];
    const saved: BookEntry[] = [
      makeBookEntry({ bookId: "b1", title: "On Page", isShared: true }),
      makeBookEntry({ bookId: "b2", title: "Off Page Book", isShared: true }),
    ];

    const merged = mergeBooks(scraped, saved);

    expect(merged).toHaveLength(2);
    const offPage = merged.find((b) => b.bookId === "b2");
    expect(offPage).toBeDefined();
    expect(offPage?.title).toBe("Off Page Book");
    expect(offPage?.isShared).toBe(true);
  });

  it("should handle empty scraped and non-empty saved", () => {
    const scraped: ScrapedBook[] = [];
    const saved: BookEntry[] = [
      makeBookEntry({ bookId: "b1", title: "Saved Book" }),
    ];

    const merged = mergeBooks(scraped, saved);

    expect(merged).toHaveLength(1);
    expect(merged[0].bookId).toBe("b1");
  });

  it("should handle non-empty scraped and empty saved", () => {
    const scraped: ScrapedBook[] = [
      makeScrapedBook({ bookId: "b1", title: "New Book" }),
    ];
    const saved: BookEntry[] = [];

    const merged = mergeBooks(scraped, saved);

    expect(merged).toHaveLength(1);
    expect(merged[0].isShared).toBe(false);
  });

  it("should handle both empty", () => {
    const merged = mergeBooks([], []);
    expect(merged).toHaveLength(0);
  });

  it("should use scraped author when available, fall back to saved author", () => {
    const scraped: ScrapedBook[] = [
      makeScrapedBook({ bookId: "b1", title: "Book", author: "New Author" }),
      makeScrapedBook({ bookId: "b2", title: "Book 2", author: "" }),
    ];
    const saved: BookEntry[] = [
      makeBookEntry({ bookId: "b1", author: "Old Author" }),
      makeBookEntry({ bookId: "b2", author: "Saved Author" }),
    ];

    const merged = mergeBooks(scraped, saved);

    const b1 = merged.find((b) => b.bookId === "b1");
    const b2 = merged.find((b) => b.bookId === "b2");
    // scraped author is truthy, so it wins (per the || chain)
    expect(b1?.author).toBe("New Author");
    // scraped author is empty string (falsy), falls back to saved
    expect(b2?.author).toBe("Saved Author");
  });

  it("should preserve isbn from saved books for existing entries", () => {
    const scraped: ScrapedBook[] = [
      makeScrapedBook({ bookId: "b1", title: "Book" }),
    ];
    const saved: BookEntry[] = [
      makeBookEntry({ bookId: "b1", isbn: "978-1234567890" }),
    ];

    const merged = mergeBooks(scraped, saved);
    expect(merged[0].isbn).toBe("978-1234567890");
  });

  it("should merge correctly with many books from different sources", () => {
    const scraped: ScrapedBook[] = Array.from({ length: 5 }, (_, i) =>
      makeScrapedBook({ bookId: `scraped-${i}`, title: `Scraped ${i}` }),
    );
    const saved: BookEntry[] = [
      // 2 overlap with scraped
      makeBookEntry({ bookId: "scraped-0", title: "Old Scraped 0", isShared: true }),
      makeBookEntry({ bookId: "scraped-1", title: "Old Scraped 1", isShared: true }),
      // 3 saved-only
      ...Array.from({ length: 3 }, (_, i) =>
        makeBookEntry({ bookId: `saved-${i}`, title: `Saved ${i}`, isShared: true }),
      ),
    ];

    const merged = mergeBooks(scraped, saved);

    // 5 scraped + 3 saved-only = 8 total
    expect(merged).toHaveLength(8);

    // Overlapping books use scraped title but saved isShared
    const s0 = merged.find((b) => b.bookId === "scraped-0");
    expect(s0?.title).toBe("Scraped 0");
    expect(s0?.isShared).toBe(true);

    // New scraped books default to isShared: false
    const s4 = merged.find((b) => b.bookId === "scraped-4");
    expect(s4?.isShared).toBe(false);
  });
});

// --- Edge cases ---

describe("Edge cases", () => {
  it("should encrypt and decrypt an empty book list", async () => {
    const key = await generateKey();
    const plaintext = makePersonalBooksJson([]);
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };
    expect(parsed.books).toHaveLength(0);
  });

  it("should handle unicode titles (繁體中文) through full E2EE cycle", async () => {
    const books: BookEntry[] = [
      makeBookEntry({ bookId: "zh-1", title: "被討厭的勇氣" }),
      makeBookEntry({ bookId: "zh-2", title: "原子習慣：細微改變帶來巨大成就的實證法則" }),
      makeBookEntry({ bookId: "zh-3", title: "人類大歷史：從野獸到扮演上帝" }),
    ];
    const plaintext = makePersonalBooksJson(books);

    const key = await generateKey();
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };

    expect(parsed.books).toHaveLength(3);
    expect(parsed.books[0].title).toBe("被討厭的勇氣");
    expect(parsed.books[1].title).toBe("原子習慣：細微改變帶來巨大成就的實證法則");
    expect(parsed.books[2].title).toBe("人類大歷史：從野獸到扮演上帝");
  });

  it("should handle a large book list (100+ entries) through E2EE cycle", async () => {
    const books: BookEntry[] = Array.from({ length: 150 }, (_, i) =>
      makeBookEntry({
        bookId: `book-${String(i).padStart(4, "0")}`,
        title: `Book Title ${i}`,
        author: `Author ${i}`,
        isShared: i % 3 === 0,
      }),
    );
    const plaintext = makePersonalBooksJson(books);

    const key = await generateKey();
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };

    expect(parsed.books).toHaveLength(150);
    expect(parsed.books[0].bookId).toBe("book-0000");
    expect(parsed.books[149].bookId).toBe("book-0149");
    // Verify isShared pattern survived
    expect(parsed.books[0].isShared).toBe(true); // 0 % 3 === 0
    expect(parsed.books[1].isShared).toBe(false);
    expect(parsed.books[3].isShared).toBe(true);
  });

  it("should fail to decrypt tampered ciphertext of a book list", async () => {
    const books = [makeBookEntry({ bookId: "t1", title: "Tamper Target" })];
    const plaintext = makePersonalBooksJson(books);

    const key = await generateKey();
    const ciphertext = await encrypt(plaintext, key);

    // Tamper with the ciphertext by flipping a character
    const mid = Math.floor(ciphertext.length / 2);
    const tampered =
      ciphertext.slice(0, mid) +
      (ciphertext[mid] === "A" ? "B" : "A") +
      ciphertext.slice(mid + 1);

    await expect(decrypt(tampered, key)).rejects.toThrow();
  });

  it("should handle books with special characters in metadata", async () => {
    const books: BookEntry[] = [
      makeBookEntry({
        bookId: "special-1",
        title: 'Book with "quotes" & <tags>',
        author: "Author O'Brien",
      }),
      makeBookEntry({
        bookId: "special-2",
        title: "Book with emoji 📚🎉 and newlines\nline2",
        author: "Author / Coauthor",
      }),
    ];
    const plaintext = makePersonalBooksJson(books);

    const key = await generateKey();
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };

    expect(parsed.books[0].title).toBe('Book with "quotes" & <tags>');
    expect(parsed.books[1].title).toContain("📚🎉");
    expect(parsed.books[1].title).toContain("\n");
  });

  it("should handle sync code with key that contains characters resembling delimiters", async () => {
    // Generate multiple keys to find one that roundtrips correctly
    // (all Base62 keys should work since they contain no dashes or @)
    const key = await generateKey();
    const exported = await exportKey(key);

    // Base62 keys should never contain dashes or @
    expect(exported).not.toContain("-");
    expect(exported).not.toContain("@");

    const syncCode = encodeSyncCode({
      familyId: "famtest",
      encryptionKey: exported,
    });
    const decoded = decodeSyncCode(syncCode);
    const reimported = await importKey(decoded.encryptionKey);

    const plaintext = "delimiter edge case";
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, reimported);
    expect(decrypted).toBe(plaintext);
  });
});
