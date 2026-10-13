/** Public-shelf records — `/api/user/:id/public-shelf*` (owner side) and the
 *  `GET /api/public/:shareToken` snapshot a link viewer reads. Re-exported by `api/types.ts`. */

import type { BookEntry } from "./types";

export type SelectionMode = "all-shared";

export interface PublicShelf {
  shelfId: string;
  shareToken: string;
  title: string;
  expiresDays: number | null;
  createdAt: number;
  expiresAt: number | null;
  selectionMode: SelectionMode;
}

export interface PublicShelfData {
  title: string;
  books: BookEntry[];
  createdAt: number;
  expiresAt: number | null;
}
