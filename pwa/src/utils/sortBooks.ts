export type BookSortMode =
  "default" | "title-asc" | "title-desc" | "author-asc" | "author-desc";

/** Canonical sort modes (post-normalization). Excludes legacy aliases. */
const CANONICAL_MODES: readonly BookSortMode[] = [
  "default",
  "title-asc",
  "title-desc",
  "author-asc",
  "author-desc",
];

/**
 * Legacy stored values (pre-direction) mapped to their ascending canonical
 * equivalent. Persisted preferences must survive this schema change without a
 * migration — old `"title"` / `"author"` values are read as `-asc`.
 */
const LEGACY_ALIASES: Record<string, BookSortMode> = {
  title: "title-asc",
  author: "author-asc",
};

/**
 * Normalize an untrusted stored/received value into a canonical BookSortMode.
 * Accepts canonical values as-is and legacy aliases as their `-asc` form;
 * anything unrecognized falls back to `"default"`.
 */
export function normalizeSortMode(value: unknown): BookSortMode {
  if (typeof value !== "string") return "default";
  if (CANONICAL_MODES.includes(value as BookSortMode)) {
    return value as BookSortMode;
  }
  // Own-property guard: prototype-chain keys (e.g. "__proto__", "toString")
  // must not resolve to inherited members; only real aliases map through.
  return Object.hasOwn(LEGACY_ALIASES, value)
    ? LEGACY_ALIASES[value]
    : "default";
}

const collator = new Intl.Collator("zh-Hant", { sensitivity: "base" });

export function sortBooks<T extends { title: string; author: string }>(
  items: T[],
  mode: BookSortMode,
): T[] {
  if (mode === "default") return items;
  const [field, direction] = mode.split("-") as [
    "title" | "author",
    "asc" | "desc",
  ];
  const sign = direction === "desc" ? -1 : 1;
  return [...items].sort((a, b) => sign * collator.compare(a[field], b[field]));
}
