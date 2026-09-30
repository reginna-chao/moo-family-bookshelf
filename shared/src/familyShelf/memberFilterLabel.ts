/** Leading part of the member-filter trigger's accessible name. */
export const MEMBER_FILTER_NAME_PREFIX = "篩選成員";

/**
 * Accessible name of the family-shelf member-filter trigger, e.g.
 * `篩選成員：其他家人的書，120 本`. An `aria-label` replaces the button's text
 * content for assistive tech, so it must carry the same `label` / `count` the
 * trigger renders. Shared so the Extension and PWA announce identical copy.
 */
export function memberFilterAccessibleName(
  label: string,
  count: number,
): string {
  return `${MEMBER_FILTER_NAME_PREFIX}：${label}，${count} 本`;
}
