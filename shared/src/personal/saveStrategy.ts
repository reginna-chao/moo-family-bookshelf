import { BoolFlag } from "../api/types";

/**
 * Decide whether a personal-shelf save should go out as a partial PATCH
 * (the `patchChanges` diff) or a full PUT.
 *
 * Shared by the Extension and PWA save flows so the (regression-prone)
 * decision stays identical on both sides. Pure function, no side effects.
 *
 * Falls back to PUT when the diff cannot be safely expressed as a PATCH:
 *  - no server record yet (`savedRawPayload === null`) → PATCH would 404
 *  - a dirty book is not on the server (a new, un-synced scraped book) →
 *    PATCH silently drops unknown bookIds, so the change would be lost
 *  - a dirty id is no longer in `books` (the user toggled an entry that a
 *    later in-session merge dropped) → the displayed list, including a
 *    possibly promoted twin, must go out whole
 *  - the PATCH `changes` would exceed the backend's cap
 *
 * Server-known bookIds absent from `books` (e.g. a legacy entry dropped
 * locally) whose server flag is still `TRUE` are sent as `isShared: FALSE`
 * changes: a PATCH never removes a book, so without them a stale server copy
 * could keep sharing a book the user just unshared. Ids already `FALSE` on
 * the server are skipped (a no-op that would only count toward the cap), and
 * after a successful PATCH the caller folds the sent unshares to `FALSE`
 * (`applyPatchChanges`), so they are not re-sent on later saves. Unlike a
 * full PUT this leaves flags another device
 * changed meanwhile untouched. The Worker PATCH handler ignores unknown ids
 * (it only rewrites books the record holds) and checks bookId only as a
 * non-empty string, so unsharing a book the server has since removed is
 * harmless.
 *
 * With `includePromoted`, a non-dirty, server-known book whose local flag
 * differs from the load-time snapshot is "promoted" (a real twin that
 * inherited a dropped legacy entry's share) and is sent too, so the share is
 * not lost. Callers fold sent flags back into the snapshot
 * (`applyPatchChanges`) so a promoted flag is not re-sent on later saves.
 */
export interface SaveStrategyInput<
  T extends { bookId: string; isShared: BoolFlag },
> {
  books: T[];
  dirtyBookIds: ReadonlySet<string>;
  /** Server payload captured at load (its `books` is the server-known set); null = no server record. */
  savedRawPayload: { books?: unknown } | null;
  /** Backend cap on PATCH `changes` length; over this → PUT. */
  maxPatchChanges: number;
  /** Send promoted books (default `false`: none sent, none counted). Extension only — the PWA must NOT
   *  set it, or a save could share a book without an opt-in. See docs/architecture.md → 個人開放設定 API. */
  includePromoted?: boolean;
}

export interface PatchChange {
  bookId: string;
  isShared: BoolFlag;
}

export interface SaveStrategy<T> {
  /** true → full PUT; false → PATCH `patchChanges`. */
  usePut: boolean;
  /** The dirty subset of `books`. */
  dirtyBooks: T[];
  /** PATCH body: dirty books' flags, then promoted twins when `includePromoted`, then an unshare per server-only id still shared on the server. */
  patchChanges: PatchChange[];
}

export function decideSaveStrategy<
  T extends { bookId: string; isShared: BoolFlag },
>(input: SaveStrategyInput<T>): SaveStrategy<T> {
  const { books, dirtyBookIds, savedRawPayload, maxPatchChanges } = input;
  const dirtyBooks = books.filter((b) => dirtyBookIds.has(b.bookId));
  const serverFlags = readServerFlags(savedRawPayload);
  const localIds = new Set(books.map((b) => b.bookId));
  const promoted = input.includePromoted
    ? findPromoted(books, dirtyBookIds, serverFlags)
    : [];
  const unshareBookIds = [...serverFlags.keys()].filter(
    (id) => !localIds.has(id) && serverFlags.get(id) === BoolFlag.TRUE,
  );
  const usePut =
    savedRawPayload === null ||
    dirtyBookIds.size + promoted.length + unshareBookIds.length >
      maxPatchChanges ||
    dirtyBooks.some((b) => !serverFlags.has(b.bookId)) ||
    [...dirtyBookIds].some((id) => !localIds.has(id));
  const patchChanges: PatchChange[] = [
    ...dirtyBooks.map((b) => ({ bookId: b.bookId, isShared: b.isShared })),
    ...promoted.map((b) => ({
      bookId: b.bookId,
      isShared: toFlag(b.isShared),
    })),
    ...unshareBookIds.map((id) => ({ bookId: id, isShared: BoolFlag.FALSE })),
  ];
  return { usePut, dirtyBooks, patchChanges };
}

/**
 * Fold sent PATCH flags back into the load-time server `books` snapshot:
 * returns a new array with `isShared` replaced on entries whose bookId was
 * sent (others untouched). Never adds books — a PATCH cannot. Non-array input
 * is returned unchanged.
 */
export function applyPatchChanges(
  serverBooks: unknown,
  changes: PatchChange[],
): unknown {
  if (!Array.isArray(serverBooks)) return serverBooks;
  const sent = new Map(changes.map((c) => [c.bookId, c.isShared]));
  return (serverBooks as unknown[]).map((entry) => {
    const bookId = (entry as { bookId?: unknown } | null)?.bookId;
    if (typeof bookId !== "string") return entry;
    const flag = sent.get(bookId);
    return flag === undefined
      ? entry
      : { ...(entry as object), isShared: flag };
  });
}

/** Non-dirty, server-known books whose local flag differs from the snapshot. */
function findPromoted<T extends { bookId: string; isShared: BoolFlag }>(
  books: T[],
  dirtyBookIds: ReadonlySet<string>,
  serverFlags: Map<string, BoolFlag>,
): T[] {
  return books.filter((b) => {
    if (dirtyBookIds.has(b.bookId)) return false;
    const serverFlag = serverFlags.get(b.bookId);
    return serverFlag !== undefined && toFlag(b.isShared) !== serverFlag;
  });
}

function toFlag(value: unknown): BoolFlag {
  return value === BoolFlag.TRUE ? BoolFlag.TRUE : BoolFlag.FALSE;
}

/** Server-known bookId → server `isShared`, in server order. Entries without a non-empty string
 *  bookId are skipped — the Worker would reject the whole PATCH if one reached `changes`. */
function readServerFlags(
  savedRawPayload: { books?: unknown } | null,
): Map<string, BoolFlag> {
  const rawServerBooks = savedRawPayload?.books;
  const flags = new Map<string, BoolFlag>();
  if (!Array.isArray(rawServerBooks)) return flags;
  for (const entry of rawServerBooks as unknown[]) {
    const book = entry as { bookId?: unknown; isShared?: unknown } | null;
    const bookId = book?.bookId;
    if (typeof bookId === "string" && bookId.length > 0) {
      flags.set(bookId, toFlag(book?.isShared));
    }
  }
  return flags;
}
