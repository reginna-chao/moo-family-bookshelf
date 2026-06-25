import { describe, it, expect } from "vitest";
import { getSegmentBorderRadius, type SegmentPosition } from "@/dialog/segmentBorderRadius";

describe("getSegmentBorderRadius", () => {
  it.each<{ position: SegmentPosition | undefined; expected: string }>([
    { position: "first", expected: "6px 0 0 6px" },
    { position: "last", expected: "0 6px 6px 0" },
    { position: "middle", expected: "0" },
    { position: undefined, expected: "0" },
  ])("returns '$expected' for position '$position' with default radius", ({ position, expected }) => {
    expect(getSegmentBorderRadius(position)).toBe(expected);
  });

  it.each<{ position: SegmentPosition; expected: string }>([
    { position: "first", expected: "8px 0 0 8px" },
    { position: "last", expected: "0 8px 8px 0" },
    { position: "middle", expected: "0" },
  ])("returns '$expected' for position '$position' with custom radius 8", ({ position, expected }) => {
    expect(getSegmentBorderRadius(position, 8)).toBe(expected);
  });
});
