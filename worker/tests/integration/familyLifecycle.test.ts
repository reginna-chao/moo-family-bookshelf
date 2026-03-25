import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe("Family Lifecycle", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) init.body = JSON.stringify(body);
    return app.request(path, init, { KV: kv });
  }

  it("should create a family", async () => {
    const res = await request("POST", "/api/family", { userId: "user1" });
    expect(res.status).toBe(201);
    const json = await res.json() as Json;
    expect(json.data.familyId).toBeDefined();
    expect(json.data.members).toEqual(["user1"]);
  });

  it("should reject create without userId", async () => {
    const res = await request("POST", "/api/family", {});
    expect(res.status).toBe(400);
    const json = await res.json() as Json;
    expect(json.error.code).toBe("MISSING_USER_ID");
  });

  it("should allow joining a family", async () => {
    // Create family
    const createRes = await request("POST", "/api/family", {
      userId: "user1",
    });
    const { familyId } = (await createRes.json() as Json).data;

    // Join family
    const joinRes = await request(`POST`, `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(joinRes.status).toBe(200);

    // Verify members
    const membersRes = await request("GET", `/api/family/${familyId}/members`);
    const members = (await membersRes.json() as Json).data;
    expect(members.members).toEqual(["user1", "user2"]);
  });

  it("should return 404 for joining non-existent family", async () => {
    const res = await request("POST", "/api/family/nonexistent/join", {
      userId: "user1",
    });
    expect(res.status).toBe(404);
    const json = await res.json() as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should not duplicate member on re-join", async () => {
    const createRes = await request("POST", "/api/family", {
      userId: "user1",
    });
    const { familyId } = (await createRes.json() as Json).data;

    await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
    });

    const membersRes = await request("GET", `/api/family/${familyId}/members`);
    const members = (await membersRes.json() as Json).data;
    expect(members.members).toEqual(["user1"]);
  });

  it("should allow leaving a family", async () => {
    const createRes = await request("POST", "/api/family", {
      userId: "user1",
    });
    const { familyId } = (await createRes.json() as Json).data;

    await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });

    // user2 leaves
    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
    );
    expect(leaveRes.status).toBe(200);

    // Verify
    const membersRes = await request("GET", `/api/family/${familyId}/members`);
    const members = (await membersRes.json() as Json).data;
    expect(members.members).toEqual(["user1"]);
  });
});

describe("Personal Books", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) init.body = JSON.stringify(body);
    return app.request(path, init, { KV: kv });
  }

  it("should return null for user with no books", async () => {
    const res = await request("GET", "/api/user/user1/books");
    expect(res.status).toBe(200);
    const json = await res.json() as Json;
    expect(json.data).toBeNull();
  });

  it("should save and retrieve encrypted books", async () => {
    const payload = "encrypted-data-here";

    const putRes = await request("PUT", "/api/user/user1/books", { payload });
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/user/user1/books");
    const json = await getRes.json() as Json;
    expect(json.data.payload).toBe(payload);
    expect(json.data.lastUpdated).toBeDefined();
  });

  it("should reject empty payload", async () => {
    const res = await request("PUT", "/api/user/user1/books", { payload: "" });
    expect(res.status).toBe(400);
  });
});

describe("Family Bookshelf Aggregation", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) init.body = JSON.stringify(body);
    return app.request(path, init, { KV: kv });
  }

  it("should aggregate books from all family members", async () => {
    // Create family with two members
    const createRes = await request("POST", "/api/family", {
      userId: "user1",
    });
    const { familyId } = (await createRes.json() as Json).data;
    await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });

    // Both members save books
    await request("PUT", "/api/user/user1/books", {
      payload: "user1-encrypted",
    });
    await request("PUT", "/api/user/user2/books", {
      payload: "user2-encrypted",
    });

    // Get family bookshelf
    const res = await request("GET", `/api/family/${familyId}/bookshelf`);
    expect(res.status).toBe(200);
    const json = await res.json() as Json;
    expect(json.data.members).toHaveLength(2);
    expect(json.data.members[0].payload).toBe("user1-encrypted");
    expect(json.data.members[1].payload).toBe("user2-encrypted");
  });

  it("should return 404 for non-existent family bookshelf", async () => {
    const res = await request("GET", "/api/family/nope/bookshelf");
    expect(res.status).toBe(404);
  });

  it("should not include former member after leave", async () => {
    const createRes = await request("POST", "/api/family", {
      userId: "user1",
    });
    const { familyId } = (await createRes.json() as Json).data;
    await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    await request("PUT", "/api/user/user2/books", {
      payload: "user2-data",
    });

    // user2 leaves
    await request("DELETE", `/api/family/${familyId}/member/user2`);

    // Bookshelf should only have user1
    const res = await request("GET", `/api/family/${familyId}/bookshelf`);
    const json = await res.json() as Json;
    expect(json.data.members).toHaveLength(1);
    expect(json.data.members[0].userId).toBe("user1");
  });
});
