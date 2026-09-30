import { describe, it, expect } from "vitest";
import {
  MEMBER_FILTER_NAME_PREFIX,
  memberFilterAccessibleName,
} from "moo-family-bookshelf-shared/familyShelf/memberFilterLabel";

describe("memberFilterAccessibleName", () => {
  // Literal expectations pin the copy: full-width 「：」「，」 and a half-width
  // space before 本. Both trigger buttons (Extension + PWA) announce this.
  it.each<{ label: string; count: number; expected: string }>([
    {
      label: "其他家人的書",
      count: 120,
      expected: "篩選成員：其他家人的書，120 本",
    },
    { label: "自己的書", count: 2, expected: "篩選成員：自己的書，2 本" },
    { label: "Alice", count: 1, expected: "篩選成員：Alice，1 本" },
    { label: "隱藏的書", count: 0, expected: "篩選成員：隱藏的書，0 本" },
  ])(
    "names $label with $count books as $expected",
    ({ label, count, expected }) => {
      expect(memberFilterAccessibleName(label, count)).toBe(expected);
    },
  );

  it("starts with the fixed 篩選成員 prefix", () => {
    expect(MEMBER_FILTER_NAME_PREFIX).toBe("篩選成員");
  });
});
