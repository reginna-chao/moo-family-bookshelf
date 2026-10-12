/** Family / personal shelf sort, read/written DIRECTLY in storage.local (a local-only UI preference):
 *  legacy `title`/`author` read as their `-asc` form, unknown as "default". See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import {
  normalizeSortMode,
  type BookSortMode,
} from "moo-family-bookshelf-shared/familyShelf/sortBooks";
import { FAMILY_SHELF_SORT_KEY, PERSONAL_SHELF_SORT_KEY } from "../constants";

export type BookSortShelf = "family" | "personal";

function sortKeyFor(shelf: BookSortShelf): string {
  return shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
}

export async function readBookSort(
  shelf: BookSortShelf,
): Promise<BookSortMode> {
  const key = sortKeyFor(shelf);
  const result = await browser.storage.local.get([key]);
  return normalizeSortMode(result[key]);
}

export async function writeBookSort(
  shelf: BookSortShelf,
  mode: BookSortMode,
): Promise<void> {
  await browser.storage.local.set({ [sortKeyFor(shelf)]: mode });
}
