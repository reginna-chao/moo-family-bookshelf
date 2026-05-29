export type BookSortMode = "default" | "title" | "author";

const collator = new Intl.Collator("zh-Hant", { sensitivity: "base" });

export function sortBooks<T extends { title: string; author: string }>(
  items: T[],
  mode: BookSortMode,
): T[] {
  if (mode === "default") return items;
  const key = mode === "title" ? "title" : "author";
  return [...items].sort((a, b) => collator.compare(a[key], b[key]));
}
