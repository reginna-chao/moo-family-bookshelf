// Caps on each `PUT /api/user/:id/books` entry's text fields (`.length`, UTF-16 units): abuse ceilings, not
// display bounds — one field must not carry megabytes every family member and public-shelf visitor downloads.
export const BOOK_TITLE_MAX_LENGTH = 200;
// The Worker's borrow route uses these same title / author caps (#331), so a book the family bookshelf
// serves is never refused as too long when borrowed — except a pre-cap value grandfathered by PUT books (#326).
export const BOOK_AUTHOR_MAX_LENGTH = 500;
export const BOOK_CATEGORY_MAX_LENGTH = 100;
/** The Extension never scrapes an ISBN; it only echoes the stored value (normally `""`). */
export const BOOK_ISBN_MAX_LENGTH = 32;

/** Field → cap, in the order the Worker reports the FIRST over-cap field (its 400 message names it). */
export const BOOK_TEXT_FIELD_LIMITS = [
  ["title", BOOK_TITLE_MAX_LENGTH],
  ["author", BOOK_AUTHOR_MAX_LENGTH],
  ["isbn", BOOK_ISBN_MAX_LENGTH],
  ["category", BOOK_CATEGORY_MAX_LENGTH],
] as const;

export type BookTextField = (typeof BOOK_TEXT_FIELD_LIMITS)[number][0];

/** True when `value` is a string longer than `max`; any non-string is not over the cap. */
export function exceedsBookFieldCap(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
}

/**
 * The first field, in `BOOK_TEXT_FIELD_LIMITS` order, whose value is a string
 * longer than its cap, or null when none is. Non-string values are ignored
 * (type checks are the caller's concern). Pure.
 */
export function overCapBookField(
  entry: Readonly<Partial<Record<BookTextField, unknown>>>,
): { field: BookTextField; max: number } | null {
  for (const [field, max] of BOOK_TEXT_FIELD_LIMITS) {
    if (exceedsBookFieldCap(entry[field], max)) return { field, max };
  }
  return null;
}
