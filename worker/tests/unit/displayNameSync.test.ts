import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

interface ResponseData {
  familyId?: string;
  authToken?: string;
  userId?: string;
  displayName?: string;
  lastUpdated?: string;
  books?: { bookId: string }[];
  schemaVersion?: number;
  members?: { userId: string; displayName: string }[];
}

/** Read a successful response body. Throws if `data` is missing — every test
 *  here exercises the success path, so this avoids optional-chaining noise. */
async function readJson(res: Response): Promise<ResponseData> {
  const body = (await res.json()) as { data?: ResponseData; error?: { code: string; message: string } };
  if (!body.data) {
    throw new Error(`Expected data in response, got error: ${JSON.stringify(body.error)}`);
  }
  return body.data;
}

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamily(userId = USER1, displayName?: string) {
  const body: Record<string, string> = { userId };
  if (displayName !== undefined) body.displayName = displayName;
  const res = await request("POST", "/api/family", body);
  const data = await readJson(res);
  return {
    familyId: data.familyId as string,
    authToken: data.authToken as string,
  };
}

async function createFamilyWithTwoMembers(displayName1?: string, displayName2?: string) {
  const { familyId, authToken: token1 } = await createFamily(USER1, displayName1);
  const joinRes = await request("POST", `/api/family/${familyId}/join`, {
    userId: USER2,
    displayName: displayName2,
  });
  const joinData = await readJson(joinRes);
  return { familyId, token1, token2: joinData.authToken as string };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Fix A: PUT /api/family/:id/member/:uid/displayName syncs user record
// ===========================================================================

describe("PUT displayName syncs user record", () => {
  it("should update user record displayName when user record exists", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1,
      userId: USER1,
      displayName: "Alice",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);

    const before = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(before.displayName).toBe("Alice");

    const updateRes = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "AliceNew" },
      token1,
    );
    expect(updateRes.status).toBe(200);

    const after = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(after.displayName).toBe("AliceNew");
  });

  it("should update user record lastUpdated when displayName changes", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "Alice", books: [],
    }, token1);

    const before = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    const oldLastUpdated = before.lastUpdated;

    await new Promise((r) => setTimeout(r, 10));

    await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "AliceUpdated" },
      token1,
    );

    const after = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(after.lastUpdated).not.toBe(oldLastUpdated);
  });

  it("should not fail when user record does not exist", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");

    // user1 has NOT saved any books yet — no user record exists
    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "AliceNew" },
      token1,
    );
    expect(res.status).toBe(200);
    const data = await readJson(res);
    expect(data.displayName).toBe("AliceNew");
  });

  it("should preserve other user record fields when syncing displayName", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1,
      userId: USER1,
      displayName: "Alice",
      books: [
        { bookId: "b1", title: "Book 1", author: "Author1", isbn: "123", coverUrl: "", readmooUrl: "", category: "fiction", isShared: 1 },
        { bookId: "b2", title: "Book 2", author: "Author2", isbn: "456", coverUrl: "", readmooUrl: "", category: "non-fiction", isShared: 0 },
      ],
    }, token1);

    await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "AliceRenamed" },
      token1,
    );

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("AliceRenamed");
    expect(data.books).toHaveLength(2);
    expect(data.books?.[0].bookId).toBe("b1");
    expect(data.books?.[1].bookId).toBe("b2");
    expect(data.userId).toBe(USER1);
    expect(data.schemaVersion).toBe(1);
  });
});

// ===========================================================================
// Fix B: PUT /api/user/:id/books uses family record's displayName
// ===========================================================================

describe("PUT books uses family displayName over client displayName", () => {
  it("should use family record displayName instead of client-supplied stale name", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "AliceNew" },
      token1,
    );

    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1,
      userId: USER1,
      displayName: "Alice", // stale!
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("AliceNew");
  });

  it("should fall back to client displayName when user is not in a family", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");

    await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "Alice", books: [],
    }, token1);

    await request("DELETE", `/api/family/${familyId}/member/${USER1}`, undefined, token1);

    const { generateAuthToken } = await import("../../src/middleware/auth");
    const newToken = await generateAuthToken(kv, USER1);

    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "AliceNoFamily", books: [],
    }, newToken);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, newToken));
    expect(data.displayName).toBe("AliceNoFamily");
  });

  it("should fall back to client displayName when family record is missing", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");

    await kv.delete(kvKeys.family(familyId));

    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "AliceFallback", books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("AliceFallback");
  });

  it("should preserve empty displayName from family record (clear is durable)", async () => {
    // Family with displayName "" (default) — empty is a deliberate state
    const { authToken: token1 } = await createFamily(USER1);

    // Even though client sends "ClientName", family record's "" wins
    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "ClientName", books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("");
  });

  it("should sanitize client-supplied displayName when user has no family", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");
    // Strip family membership so the fallback path runs
    await kv.delete(kvKeys.family(familyId));
    await kv.delete(kvKeys.member(USER1));

    // Zero-width space embedded in "Alice​" should be stripped by sanitizer
    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "Alice​", books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("Alice");
  });

  it("should reject and store empty when fallback displayName exceeds max length", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");
    await kv.delete(kvKeys.family(familyId));
    await kv.delete(kvKeys.member(USER1));

    // 21 chars, exceeds DISPLAY_NAME_MAX_LENGTH (20). sanitizer returns null → "".
    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "A".repeat(21), books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("");
  });

  it("should use family displayName even when client sends empty string", async () => {
    const { token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    const putRes = await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "", books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const data = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(data.displayName).toBe("Alice");
  });

  it("should handle both fixes together: rename then sync books", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers("Alice", "Bob");

    await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "Alice",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);
    await request("PUT", `/api/user/${USER2}/books`, {
      schemaVersion: 1, userId: USER2, displayName: "Bob",
      books: [{ bookId: "b2", title: "Book 2", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token2);

    await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "AliceNew" },
      token1,
    );

    // Fix A: user record already reflects "AliceNew"
    const user = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(user.displayName).toBe("AliceNew");

    // Extension syncs books with stale "Alice"
    await request("PUT", `/api/user/${USER1}/books`, {
      schemaVersion: 1, userId: USER1, displayName: "Alice",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);

    // Fix B: server overrides with "AliceNew" from family record
    const afterSync = await readJson(await request("GET", `/api/user/${USER1}/books`, undefined, token1));
    expect(afterSync.displayName).toBe("AliceNew");

    // Family bookshelf reflects "AliceNew" too
    const bookshelf = await readJson(await request("GET", `/api/family/${familyId}/bookshelf`, undefined, token1));
    const user1Member = bookshelf.members?.find((m) => m.userId === USER1);
    expect(user1Member?.displayName).toBe("AliceNew");
  });
});
