import { describe, it, expect } from "vitest";
import { kvKeys } from "../../src/kv/schema";

describe("kvKeys", () => {
  it("should generate user key", () => {
    expect(kvKeys.user("abc123")).toBe("user:abc123");
  });

  it("should generate family key", () => {
    expect(kvKeys.family("fam-001")).toBe("family:fam-001");
  });

  it("should generate member key", () => {
    expect(kvKeys.member("user1")).toBe("member:user1");
  });
});
