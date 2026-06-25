export type SegmentPosition = "first" | "middle" | "last";

export function getSegmentBorderRadius(position?: SegmentPosition, radius = 6): string {
  if (position === "first") return `${radius}px 0 0 ${radius}px`;
  if (position === "last") return `0 ${radius}px ${radius}px 0`;
  return "0";
}
