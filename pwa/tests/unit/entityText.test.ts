import { describe, it, expect, afterEach } from "vitest";
import {
  sanitizeBookText,
  sanitizeBookshelfMemberText,
  sanitizeBorrowRequestText,
  sanitizeFamilyBookshelfText,
  sanitizeFamilyGroupText,
  sanitizeMemberText,
  sanitizePersonalBooksText,
  sanitizePublicShelfDataText,
  sanitizePublicShelfListText,
  sanitizePublicShelfResultText,
  sanitizePublicShelfText,
  sanitizeVersionInfoText,
} from "moo-family-bookshelf-shared/api/entityText";
import { BoolFlag, BorrowStatus } from "@/api/client";
import type {
  BookEntry,
  BorrowRequest,
  FamilyBookshelf,
  FamilyGroup,
  FamilyMember,
  PersonalBooks,
  PublicShelf,
  PublicShelfData,
  VersionInfo,
} from "@/api/client";

/**
 * The per-entity half of the backend-text hardening. Threat model in full at
 * `shared/src/api/safeText.ts`; the short version is that both clients bare-cast
 * their envelope and the endpoint is user-configurable (BYO backend), so every
 * declared-`string` field is really `unknown`. An object reaching a JSX child
 * throws React 19's "Objects are not valid as a React child"; a non-string
 * reaching `.toLowerCase()` / `.trim()` / `.localeCompare()` throws a
 * TypeError. Neither app has an ErrorBoundary, so either one white-screens the
 * whole UI.
 *
 * The sanitizers take structural parameters so `shared/` depends on neither
 * consumer. The fixtures below stay full PWA entity types on purpose — that
 * also pins the PWA's own types as assignable to the shared shapes, which is
 * the drift this file exists to catch. The PWA's bookshelf shape is genuinely
 * wider than the Extension's (`familyId` on the shelf, `lastUpdated` on each
 * member), so those tri-state fields are only covered here.
 * `extension/tests/unit/entityText.test.ts` does the same for the Extension's
 * types (and covers `sanitizeOtpInfoText`, which only that client wires).
 *
 * Three exclusions are deliberate and pinned here as `untouchedFields`, so a
 * later "let's sanitize everything" sweep fails instead of quietly landing:
 *   - `authToken` — a credential, never rendered; degrading it to `""` would
 *     hide a broken backend behind a silent re-auth loop.
 *   - `coverUrl` / `bookCoverUrl` — they only reach an attribute, which the DOM
 *     string-coerces; URL-scheme allowlisting is a separate concern.
 *   - `status` / `selectionMode` — enum/literal unions whose render sites
 *     already harden them via `ReadonlyMap` lookups; a plain `string` would
 *     break their types.
 */

/**
 * Hostile values a real JSON body can carry in a field declared `string`.
 * `undefined` is deliberately absent: for a REQUIRED field it means the same as
 * any other non-string, but for an OPTIONAL one it means "absent", which has its
 * own dedicated cases below.
 */
const HOSTILE_SHAPES: readonly { name: string; value: unknown }[] = [
  { name: "a plain object", value: { message: "boom" } },
  { name: "a nested object", value: { i18n: { "zh-TW": "標題" } } },
  { name: "an array", value: ["first", "second"] },
  { name: "a number", value: 42 },
  { name: "the number 0", value: 0 },
  { name: "a boolean", value: true },
  { name: "null", value: null },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function withField<T extends object>(
  record: T,
  key: string,
  value: unknown,
): T {
  return { ...record, [key]: value } as T;
}

/** Rebuild without `key` — a genuinely absent field, not `key: undefined`. */
function withoutField<T extends object>(record: T, key: string): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== key) out[k] = v;
  }
  return out as T;
}

/** One record with EVERY listed field carrying a different hostile shape. */
function allHostile<T extends object>(record: T, fields: readonly string[]): T {
  return fields.reduce<T>(
    (acc, field, index) =>
      withField(
        acc,
        field,
        HOSTILE_SHAPES[index % HOSTILE_SHAPES.length].value,
      ),
    record,
  );
}

function cross(fields: readonly string[]) {
  return fields.flatMap((field) =>
    HOSTILE_SHAPES.map(({ name, value }) => ({ field, shape: name, value })),
  );
}

interface SanitizerSpec<T extends object> {
  sanitize: (record: T) => T;
  valid: T;
  /** Declared `string`, always present → any non-string degrades to `""`. */
  textFields?: readonly (keyof T & string)[];
  /** Declared `string | undefined` → absence survives, presence coerces to `""`. */
  optionalTextFields?: readonly (keyof T & string)[];
  /** Tri-state `string | null` → absence survives, everything non-string → `null`. */
  nullableTextFields?: readonly (keyof T & string)[];
  /** Must survive byte-identical, hostile or not (credentials, enums, URLs, numbers). */
  untouchedFields?: readonly (keyof T & string)[];
}

function describeEntitySanitizer<T extends object>(
  name: string,
  spec: SanitizerSpec<T>,
): void {
  const textFields = spec.textFields ?? [];
  const optionalTextFields = spec.optionalTextFields ?? [];
  const nullableTextFields = spec.nullableTextFields ?? [];
  const untouchedFields = spec.untouchedFields ?? [];
  const everyTextField = [
    ...textFields,
    ...optionalTextFields,
    ...nullableTextFields,
  ];

  describe(name, () => {
    // A REAL payload must come back byte-identical. This is what pins that the
    // explicit `undefined` the sanitizer writes for an absent optional field is
    // harmless on the write paths: `JSON.stringify` drops it.
    it("round-trips a fully valid record JSON.stringify-identical", () => {
      expect(JSON.stringify(spec.sanitize(spec.valid))).toBe(
        JSON.stringify(spec.valid),
      );
    });

    it("does not mutate the record it was handed", () => {
      const hostileRecord = allHostile(spec.valid, everyTextField);
      const snapshot = JSON.stringify(hostileRecord);

      spec.sanitize(hostileRecord);

      expect(JSON.stringify(hostileRecord)).toBe(snapshot);
    });

    it("never throws, whatever the text fields carry", () => {
      for (const { value } of HOSTILE_SHAPES) {
        const hostileRecord = everyTextField.reduce<T>(
          (acc, field) => withField(acc, field, value),
          spec.valid,
        );
        expect(() => spec.sanitize(hostileRecord)).not.toThrow();
      }
    });

    if (textFields.length > 0) {
      it.each(cross(textFields))(
        'degrades $field carrying $shape to ""',
        ({ field, value }) => {
          const out = spec.sanitize(withField(spec.valid, field, value));
          expect(asRecord(out)[field]).toBe("");
        },
      );

      it.each(textFields)('degrades an omitted %s to ""', (field) => {
        const out = spec.sanitize(withoutField(spec.valid, field));
        expect(asRecord(out)[field]).toBe("");
      });
    }

    if (optionalTextFields.length > 0) {
      it.each(cross(optionalTextFields))(
        'degrades $field carrying $shape to ""',
        ({ field, value }) => {
          const out = spec.sanitize(withField(spec.valid, field, value));
          expect(asRecord(out)[field]).toBe("");
        },
      );

      it.each(optionalTextFields)(
        "keeps %s absent when the backend omitted it",
        (field) => {
          const record = withoutField(spec.valid, field);

          const out = spec.sanitize(record);

          expect(asRecord(out)[field]).toBeUndefined();
          expect(JSON.stringify(out)).toBe(JSON.stringify(record));
        },
      );
    }

    if (nullableTextFields.length > 0) {
      it.each(cross(nullableTextFields))(
        "degrades $field carrying $shape to null",
        ({ field, value }) => {
          const out = spec.sanitize(withField(spec.valid, field, value));
          expect(asRecord(out)[field]).toBeNull();
        },
      );

      // `null` carries meaning here ("uses the default endpoint", "never
      // synced"), so the tri-state must survive with exactly the three values
      // it had.
      it.each(nullableTextFields)(
        "keeps an explicit null %s as null",
        (field) => {
          const out = spec.sanitize(withField(spec.valid, field, null));
          expect(asRecord(out)[field]).toBeNull();
        },
      );

      it.each(nullableTextFields)(
        "keeps %s absent when the backend omitted it",
        (field) => {
          const record = withoutField(spec.valid, field);

          const out = spec.sanitize(record);

          expect(asRecord(out)[field]).toBeUndefined();
          expect(JSON.stringify(out)).toBe(JSON.stringify(record));
        },
      );
    }

    it("degrades every text field at once", () => {
      const out = spec.sanitize(allHostile(spec.valid, everyTextField));

      for (const field of [...textFields, ...optionalTextFields]) {
        expect(asRecord(out)[field]).toBe("");
      }
      for (const field of nullableTextFields) {
        expect(asRecord(out)[field]).toBeNull();
      }
    });

    if (untouchedFields.length > 0) {
      it.each(untouchedFields)(
        "leaves a valid %s byte-identical while degrading the text fields",
        (field) => {
          const out = spec.sanitize(allHostile(spec.valid, everyTextField));
          expect(asRecord(out)[field]).toBe(asRecord(spec.valid)[field]);
        },
      );

      // The deliberate exclusions: these fields are NOT this layer's business,
      // so even a hostile value must reach the caller unchanged.
      it.each(untouchedFields)(
        "leaves %s untouched even when it is itself hostile",
        (field) => {
          const marker = { deliberatelyNotSanitized: true };

          const out = spec.sanitize(withField(spec.valid, field, marker));

          expect(asRecord(out)[field]).toBe(marker);
        },
      );
    }
  });
}

// --- Fixtures (PWA types) ---

const USER_ID = "a".repeat(64);
const OTHER_USER_ID = "b".repeat(64);

const VALID_BOOK: BookEntry = {
  bookId: "210012345000",
  title: "小王子",
  author: "Antoine de Saint-Exupéry",
  isbn: "9789573317249",
  coverUrl: "https://cdn.readmoo.com/cover/210012345000.jpg",
  readmooUrl: "https://readmoo.com/book/210012345000",
  category: "文學小說",
  isShared: BoolFlag.TRUE,
  isArchived: BoolFlag.FALSE,
};

const VALID_MEMBER: FamilyMember = {
  userId: USER_ID,
  displayName: "小明",
  canLend: BoolFlag.TRUE,
  readmooName: "ming@readmoo",
};

const VALID_GROUP: FamilyGroup = {
  familyId: "fam-abc123",
  ownerId: USER_ID,
  members: [VALID_MEMBER],
  maxMembers: 6,
  createdAt: "2026-04-26T00:00:00Z",
  apiEndpoint: "https://byo.example.com",
  authToken: "tok-secret-value",
  expiresAt: 1_700_000_000_000,
};

type BookshelfMember = FamilyBookshelf["members"][number];

const VALID_BOOKSHELF_MEMBER: BookshelfMember = {
  userId: USER_ID,
  displayName: "小明",
  books: [VALID_BOOK],
  lastUpdated: "2026-04-26T00:00:00Z",
};

const VALID_BOOKSHELF: FamilyBookshelf = {
  familyId: "fam-abc123",
  members: [VALID_BOOKSHELF_MEMBER],
};

const VALID_PERSONAL: PersonalBooks = {
  schemaVersion: 1,
  userId: USER_ID,
  displayName: "小明",
  books: [VALID_BOOK],
  lastUpdated: "2026-04-26T00:00:00Z",
  familyShelfPrefs: { hidden: [], favorites: ["210012345000"] },
};

const VALID_REQUEST: BorrowRequest = {
  requestId: "req-123",
  familyId: "fam-abc123",
  borrowerId: OTHER_USER_ID,
  borrowerName: "小華",
  ownerId: USER_ID,
  bookId: "210012345000",
  bookTitle: "小王子",
  bookAuthor: "Antoine de Saint-Exupéry",
  bookCoverUrl: "https://cdn.readmoo.com/cover/210012345000.jpg",
  status: BorrowStatus.PENDING,
  createdAt: "2026-04-26T00:00:00Z",
  updatedAt: "2026-04-26T01:00:00Z",
};

const VALID_SHELF: PublicShelf = {
  shelfId: "shelf-1",
  shareToken: "tok-abc",
  title: "小明 的公開書櫃",
  expiresDays: 30,
  createdAt: 1_700_000_000_000,
  expiresAt: null,
  selectionMode: "all-shared",
};

const VALID_SHELF_DATA: PublicShelfData = {
  title: "小明 的公開書櫃",
  books: [VALID_BOOK],
  createdAt: 1_700_000_000_000,
  expiresAt: null,
};

const VALID_VERSION: VersionInfo = {
  apiVersion: 1,
  serverVersion: "1.6.0",
};

// --- Table-driven field coverage ---

describeEntitySanitizer<BookEntry>("sanitizeBookText", {
  sanitize: sanitizeBookText,
  valid: VALID_BOOK,
  textFields: ["bookId", "title", "author", "isbn", "readmooUrl", "category"],
  untouchedFields: ["coverUrl", "isShared", "isArchived"],
});

describeEntitySanitizer<FamilyMember>("sanitizeMemberText", {
  sanitize: sanitizeMemberText,
  valid: VALID_MEMBER,
  // `userId` matters as much as the names: `userId.slice(0, 8)` is the member
  // label fallback in both apps.
  textFields: ["userId", "displayName"],
  optionalTextFields: ["readmooName"],
  untouchedFields: ["canLend"],
});

describeEntitySanitizer<FamilyGroup>("sanitizeFamilyGroupText", {
  sanitize: sanitizeFamilyGroupText,
  valid: VALID_GROUP,
  textFields: ["familyId", "ownerId", "createdAt"],
  nullableTextFields: ["apiEndpoint"],
  untouchedFields: ["maxMembers", "authToken", "expiresAt"],
});

describeEntitySanitizer<BookshelfMember>("sanitizeBookshelfMemberText", {
  sanitize: sanitizeBookshelfMemberText,
  valid: VALID_BOOKSHELF_MEMBER,
  textFields: ["userId", "displayName"],
  // PWA-only: `null` means "this member has never synced", which the shelf
  // renders differently from a timestamp it failed to read.
  nullableTextFields: ["lastUpdated"],
});

describeEntitySanitizer<FamilyBookshelf>("sanitizeFamilyBookshelfText", {
  sanitize: sanitizeFamilyBookshelfText,
  valid: VALID_BOOKSHELF,
  /**
   * PWA-only field — the Extension's bookshelf shape omits it entirely, so the
   * shared sanitizer declares it OPTIONAL and an omitted `familyId` stays
   * `undefined` rather than becoming `""`. Pinned as optional on purpose: a
   * required-field rule here would make the sanitizer invent a key the
   * Extension's payload never had, breaking its byte-identical round-trip. The
   * PWA reads the family id from its own auth state, never from this payload,
   * so the `undefined` never reaches a render or a string method.
   */
  optionalTextFields: ["familyId"],
});

describeEntitySanitizer<PersonalBooks>("sanitizePersonalBooksText", {
  sanitize: sanitizePersonalBooksText,
  valid: VALID_PERSONAL,
  textFields: ["userId", "displayName", "lastUpdated"],
  untouchedFields: ["schemaVersion", "familyShelfPrefs"],
});

describeEntitySanitizer<BorrowRequest>("sanitizeBorrowRequestText", {
  sanitize: sanitizeBorrowRequestText,
  valid: VALID_REQUEST,
  textFields: [
    "requestId",
    "familyId",
    "borrowerId",
    "borrowerName",
    "ownerId",
    "bookId",
    "bookTitle",
    "bookAuthor",
    "createdAt",
    "updatedAt",
  ],
  untouchedFields: ["bookCoverUrl", "status"],
});

describeEntitySanitizer<PublicShelf>("sanitizePublicShelfText", {
  sanitize: sanitizePublicShelfText,
  valid: VALID_SHELF,
  textFields: ["shelfId", "shareToken", "title"],
  untouchedFields: ["expiresDays", "createdAt", "expiresAt", "selectionMode"],
});

describeEntitySanitizer<PublicShelfData>("sanitizePublicShelfDataText", {
  sanitize: sanitizePublicShelfDataText,
  valid: VALID_SHELF_DATA,
  textFields: ["title"],
  untouchedFields: ["createdAt", "expiresAt"],
});

describeEntitySanitizer<VersionInfo>("sanitizeVersionInfoText", {
  sanitize: sanitizeVersionInfoText,
  valid: VALID_VERSION,
  textFields: ["serverVersion"],
  untouchedFields: ["apiVersion"],
});

// --- Nested collections ---

/**
 * The collection fields are where a hostile payload gets a second shot at the
 * UI: one bad element used to be enough to throw out of `.map`, and the guard
 * has to hold for a list that is not a list at all.
 */
describe("nested collections", () => {
  it("sanitizes every member of a family group", () => {
    const out = sanitizeFamilyGroupText({
      ...VALID_GROUP,
      members: [
        allHostile(VALID_MEMBER, ["userId", "displayName", "readmooName"]),
        VALID_MEMBER,
      ],
    });

    expect(out.members[0].userId).toBe("");
    expect(out.members[0].displayName).toBe("");
    expect(out.members[0].readmooName).toBe("");
    expect(out.members[1]).toEqual(VALID_MEMBER);
  });

  it.each([
    { name: "a string", value: "not-an-array" },
    { name: "null", value: null },
    { name: "a number", value: 3 },
    { name: "an object", value: { length: 2 } },
  ])("passes a members list that is $name straight through", ({ value }) => {
    const group = withField(VALID_GROUP, "members", value);

    const out = sanitizeFamilyGroupText(group);

    expect(out.members).toBe(value);
  });

  it("lets a null member survive instead of throwing on it", () => {
    const group = withField(VALID_GROUP, "members", [
      null,
      allHostile(VALID_MEMBER, ["displayName"]),
    ]);

    const out = sanitizeFamilyGroupText(group);

    expect(out.members[0]).toBeNull();
    expect(out.members[1].displayName).toBe("");
  });

  it("sanitizes books two levels down, inside a bookshelf member", () => {
    const out = sanitizeFamilyBookshelfText({
      ...VALID_BOOKSHELF,
      members: [
        {
          ...VALID_BOOKSHELF_MEMBER,
          books: [allHostile(VALID_BOOK, ["title", "author", "bookId"])],
        },
      ],
    });

    expect(out.members[0].books[0].title).toBe("");
    expect(out.members[0].books[0].author).toBe("");
    expect(out.members[0].books[0].bookId).toBe("");
    // The cover URL is not this layer's business, even two levels down.
    expect(out.members[0].books[0].coverUrl).toBe(VALID_BOOK.coverUrl);
    expect(out.members[0].books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it.each([
    { name: "a string", value: "nope" },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])(
    "passes a bookshelf whose members list is $name straight through",
    ({ value }) => {
      const shelf = withField(VALID_BOOKSHELF, "members", value);

      expect(() => sanitizeFamilyBookshelfText(shelf)).not.toThrow();
      expect(sanitizeFamilyBookshelfText(shelf).members).toBe(value);
    },
  );

  it("passes a personal-books list that is not an array straight through", () => {
    const personal = withField(VALID_PERSONAL, "books", "nope");

    expect(sanitizePersonalBooksText(personal).books).toBe("nope");
  });

  it("lets a null book survive inside the personal book list", () => {
    const personal = withField(VALID_PERSONAL, "books", [null, VALID_BOOK]);

    const out = sanitizePersonalBooksText(personal);

    expect(out.books[0]).toBeNull();
    expect(out.books[1]).toEqual(VALID_BOOK);
  });

  it("preserves the index-signature extras a future schema may add", () => {
    const personal = withField(VALID_PERSONAL, "futureField", { keep: "me" });

    const out = sanitizePersonalBooksText(personal);

    expect(asRecord(out).futureField).toEqual({ keep: "me" });
  });

  it("sanitizes every book of a public shelf snapshot", () => {
    const out = sanitizePublicShelfDataText({
      ...VALID_SHELF_DATA,
      books: [allHostile(VALID_BOOK, ["title", "author", "category"])],
    });

    expect(out.books[0].title).toBe("");
    expect(out.books[0].author).toBe("");
    expect(out.books[0].category).toBe("");
    expect(out.books[0].coverUrl).toBe(VALID_BOOK.coverUrl);
  });

  it.each([
    { name: "a string", value: "nope" },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])(
    "passes a snapshot books list that is $name straight through",
    ({ value }) => {
      const data = withField(VALID_SHELF_DATA, "books", value);

      expect(() => sanitizePublicShelfDataText(data)).not.toThrow();
      expect(sanitizePublicShelfDataText(data).books).toBe(value);
    },
  );

  it("lets a null book survive inside a public shelf snapshot", () => {
    const data = withField(VALID_SHELF_DATA, "books", [null, VALID_BOOK]);

    const out = sanitizePublicShelfDataText(data);

    expect(out.books[0]).toBeNull();
    expect(out.books[1]).toEqual(VALID_BOOK);
  });

  it("sanitizes every shelf in a public-shelf list", () => {
    const out = sanitizePublicShelfListText({
      shelves: [allHostile(VALID_SHELF, ["shelfId", "shareToken", "title"])],
    });

    expect(out.shelves[0].shelfId).toBe("");
    expect(out.shelves[0].shareToken).toBe("");
    expect(out.shelves[0].title).toBe("");
    expect(out.shelves[0].selectionMode).toBe("all-shared");
  });

  it.each([
    { name: "a string", value: "nope" },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])("passes a shelves list that is $name straight through", ({ value }) => {
    const list = withField({ shelves: [VALID_SHELF] }, "shelves", value);

    expect(() => sanitizePublicShelfListText(list)).not.toThrow();
    expect(sanitizePublicShelfListText(list).shelves).toBe(value);
  });

  it("sanitizes the single shelf of a public-shelf write result", () => {
    const out = sanitizePublicShelfResultText({
      shelf: allHostile(VALID_SHELF, ["shelfId", "shareToken", "title"]),
    });

    expect(out.shelf.title).toBe("");
    expect(out.shelf.shareToken).toBe("");
    expect(out.shelf.expiresDays).toBe(30);
  });

  it.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "a string", value: "nope" },
  ])(
    "passes a write result whose shelf is $name straight through",
    ({ value }) => {
      const result = withField({ shelf: VALID_SHELF }, "shelf", value);

      expect(() => sanitizePublicShelfResultText(result)).not.toThrow();
      expect(sanitizePublicShelfResultText(result).shelf).toBe(value);
    },
  );
});

/**
 * `authToken` is the one declared-`string` field left alone on purpose. It is a
 * credential — never rendered, never handed to a string method — and degrading
 * it to `""` would swap the 401 the request already produces for a silent
 * re-auth loop the user cannot diagnose.
 */
describe("authToken exclusion", () => {
  it("keeps a valid authToken byte-identical", () => {
    expect(sanitizeFamilyGroupText(VALID_GROUP).authToken).toBe(
      "tok-secret-value",
    );
  });

  it("does not coerce a non-string authToken to an empty string", () => {
    const out = sanitizeFamilyGroupText(
      withField(VALID_GROUP, "authToken", 42),
    );

    expect(out.authToken).toBe(42);
    expect(out.authToken).not.toBe("");
  });
});

// --- Prototype pollution ---

/** The marker a successful pollution attempt would leave behind. */
const POLLUTION_KEY = "polluted";

/**
 * Hostile payloads kept as RAW JSON text on purpose: they only carry a genuine
 * own `__proto__` / `constructor` key once `JSON.parse` has run over them.
 */
const PROTO_BOOK_JSON =
  '{"bookId":"b1","title":"t","author":"","isbn":"","readmooUrl":"","category":"","__proto__":{"polluted":1}}';
const CONSTRUCTOR_MEMBER_JSON =
  '{"userId":"u1","displayName":"小明","constructor":{"prototype":{"polluted":1}}}';
const PROTO_MEMBER_JSON =
  '{"userId":"u1","displayName":{"i18n":"boom"},"__proto__":{"polluted":1}}';

/**
 * Parse a hostile payload and pin the two facts that make it hostile: the
 * smuggled key exists as an OWN property, and parsing it has not already moved
 * the prototype. Without this guard, a later "cleanup" of these fixtures into
 * object literals would make every case below vacuous — and still green.
 */
function parseHostile<T>(json: string, hostileKey: string): T {
  const record = asRecord(JSON.parse(json));

  expect(Object.hasOwn(record, hostileKey)).toBe(true);
  expect(Object.getPrototypeOf(record)).toBe(Object.prototype);

  return record as unknown as T;
}

const POLLUTION_ATTEMPTS: readonly {
  name: string;
  hostileKey: string;
  hostileValue: unknown;
  sanitize: () => unknown;
}[] = [
  {
    name: "a book carrying an own __proto__ key",
    hostileKey: "__proto__",
    hostileValue: { [POLLUTION_KEY]: 1 },
    sanitize: () =>
      sanitizeBookText(parseHostile<BookEntry>(PROTO_BOOK_JSON, "__proto__")),
  },
  {
    name: "a member carrying an own constructor key",
    hostileKey: "constructor",
    hostileValue: { prototype: { [POLLUTION_KEY]: 1 } },
    sanitize: () =>
      sanitizeMemberText(
        parseHostile<FamilyMember>(CONSTRUCTOR_MEMBER_JSON, "constructor"),
      ),
  },
];

/**
 * A tripwire, not a behaviour test.
 *
 * The sanitizers are safe today because of ONE subtle JS semantic: object
 * spread (`{ ...record, title: safeText(record.title) }`) copies own keys with
 * CreateDataProperty, never with `Set`. So a `__proto__` key that arrived as
 * real DATA — which is what `JSON.parse` produces, unlike an object literal,
 * where the parser special-cases it into a [[Prototype]] assignment — is copied
 * onto the result as an inert own data property, and the `__proto__` accessor
 * inherited from `Object.prototype` is never invoked.
 *
 * Rewrite any sanitizer to `Object.assign({}, record, …)` or a `for…in` copy and
 * that defence silently disappears: both assign through `Set`, which DOES find
 * the inherited accessor and hands it the attacker's object. Every other test in
 * this file stays green through such a rewrite — these cases are the only ones
 * that go red, which is the entire reason they exist.
 *
 * Which assertion catches which rewrite, stated honestly:
 *   - `Object.getPrototypeOf(result)` and the own-descriptor check catch the
 *     `Object.assign` / `for…in` rewrite: there the RESULT's prototype becomes
 *     the attacker's object and the smuggled key stops existing as data, so the
 *     attacker's fields become readable through the very object the UI renders
 *     from. The process-wide `Object.prototype` stays clean, so those checks
 *     alone would NOT notice.
 *   - The `Object.prototype` checks catch the worse but less likely rewrite — a
 *     recursive merge, the only shape that reaches the global. They are the
 *     weaker net; both are kept.
 */
describe("prototype pollution", () => {
  // Cleanup must survive a RED run: a failing assertion below would still leave
  // the marker on `Object.prototype`, where it would silently corrupt every
  // later test in the process.
  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, POLLUTION_KEY);
  });

  it.each(POLLUTION_ATTEMPTS)(
    "pollutes neither the result nor Object.prototype given $name",
    ({ sanitize }) => {
      const out = asRecord(sanitize());

      // The object the UI renders from.
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(out[POLLUTION_KEY]).toBeUndefined();
      // Every other object in the process.
      expect(asRecord({})[POLLUTION_KEY]).toBeUndefined();
      expect(Object.hasOwn(Object.prototype, POLLUTION_KEY)).toBe(false);
    },
  );

  it.each(POLLUTION_ATTEMPTS)(
    "copies the smuggled key through as an inert own data property given $name",
    ({ sanitize, hostileKey, hostileValue }) => {
      const out = asRecord(sanitize());

      // A DATA descriptor is the whole point: it proves the copy went through
      // CreateDataProperty instead of the inherited `__proto__` setter.
      expect(Object.getOwnPropertyDescriptor(out, hostileKey)).toEqual({
        value: hostileValue,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(Object.keys(out)).toContain(hostileKey);
    },
  );

  it("keeps a hostile member inert one level down, inside a family group", () => {
    const out = sanitizeFamilyGroupText({
      ...VALID_GROUP,
      members: [parseHostile<FamilyMember>(PROTO_MEMBER_JSON, "__proto__")],
    });
    const member = asRecord(out.members[0]);

    // The element really went through `sanitizeMemberText`: without this line
    // the assertions below would hold just as well for a list never visited.
    expect(member.displayName).toBe("");
    expect(Object.getPrototypeOf(member)).toBe(Object.prototype);
    expect(member[POLLUTION_KEY]).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(member, "__proto__")).toEqual({
      value: { [POLLUTION_KEY]: 1 },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(asRecord({})[POLLUTION_KEY]).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, POLLUTION_KEY)).toBe(false);
  });
});
