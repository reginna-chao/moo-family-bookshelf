import { describe, it, expect } from "vitest";
import {
  JOIN_BLOCKED_MESSAGES,
  FAMILY_FULL_MESSAGE,
} from "@/utils/joinErrorMessages";

describe("JOIN_BLOCKED_MESSAGES", () => {
  // 文案的唯一字面錨點：App.test.tsx 只驗「碼 → 對到哪一格 → 有送到 render site」，
  // 期望值取自生產 map，因此無法固定內容本身；這裡逐字釘住。
  it.each([
    ["FAMILY_FULL", "家庭成員已達上限（每個家庭最多 2 位成員）"],
    ["MEMBER_REMOVED", "你已被家庭管理者移出，已為你登出"],
    ["FAMILY_NOT_FOUND", "找不到這個家庭，家庭可能已被解散"],
    ["ALREADY_IN_FAMILY", "此帳號已加入其他家庭，請先離開原本的家庭"],
  ])("pins the 繁中 copy for %s", (code, copy) => {
    expect(JOIN_BLOCKED_MESSAGES.get(code)).toBe(copy);
  });

  it("keeps FAMILY_FULL_MESSAGE and the map entry as one string", () => {
    expect(JOIN_BLOCKED_MESSAGES.get("FAMILY_FULL")).toBe(FAMILY_FULL_MESSAGE);
  });
});
