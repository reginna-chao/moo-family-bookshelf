import type { ApiResponse, PersonalBooks } from "../api/types";

/** Types and pure set helpers behind `FamilyPrefsSync`, split out so `./prefsSync.ts` stays about
 *  lifecycle only; import them through `./prefsSync`, which re-exports every public name. */

/** Independent viewer-private preference kinds sharing one KV record. */
export type FamilyPrefKind = "hidden" | "favorites";

/** Complete ref arrays for every kind — the full-replace body a flush sends. */
export type FamilyShelfPrefsRecord = NonNullable<
  PersonalBooks["familyShelfPrefs"]
>;

/**
 * The two API calls the controller needs. Structural, so both apps' `ApiClient`
 * satisfy it without a cast.
 */
export interface FamilyPrefsApi {
  getPersonalBooks(
    userId: string,
  ): Promise<ApiResponse<Pick<PersonalBooks, "familyShelfPrefs">>>;
  updateFamilyPrefs(
    userId: string,
    prefs: FamilyShelfPrefsRecord,
  ): Promise<ApiResponse<unknown>>;
}

/** Who the controller acts for, and through which client. */
export interface FamilyPrefsIo {
  userId: string;
  api: FamilyPrefsApi;
}

export interface FamilyPrefsSyncOptions {
  /** Read at call time, never cached: a flush — including `detach()`'s on unmount — must use
   *  the CURRENT userId/client, not the values the controller was created with. */
  getIo: () => FamilyPrefsIo;
  /** Publishes a kind's current ref set (after a load, after each toggle). */
  onRefs: (kind: FamilyPrefKind, refs: Set<string>) => void;
  /** Publishes the latest load / flush outcome. Never called while detached. */
  onSyncFailed: (failed: boolean) => void;
}

/** What each app's `useFamilyShelfPrefs` hook returns. */
export interface FamilyShelfPrefs {
  hiddenRefs: Set<string>;
  isHidden: (ownerId: string, bookId: string) => boolean;
  toggleHidden: (ownerId: string, bookId: string) => void;
  favoriteRefs: Set<string>;
  isFavorite: (ownerId: string, bookId: string) => boolean;
  toggleFavorite: (ownerId: string, bookId: string) => void;
  /** True when the latest load or debounced flush failed (network or `{ error }`). */
  syncFailed: boolean;
}

export type RefsByKind = Record<FamilyPrefKind, Set<string>>;

export function emptyRefsByKind(): RefsByKind {
  return { hidden: new Set(), favorites: new Set() };
}

/** A NEW set with `ref` flipped; the input is never mutated. */
export function toggledRef(refs: Set<string>, ref: string): Set<string> {
  const next = new Set(refs);
  if (next.has(ref)) {
    next.delete(ref);
  } else {
    next.add(ref);
  }
  return next;
}

/**
 * Replays pre-load toggles onto the loaded record as ADDITIONS ONLY: per kind,
 * loaded ∪ delta. Before the first successful load the UI shows every book
 * unmarked, so a ref toggled an odd number of times can only mean "mark it";
 * a pre-load click must never remove a mark the user could not see — that
 * would delete it on the next full-replace save (issue #219). A ref toggled an
 * even number of times is absent from the delta and keeps its loaded state.
 */
export function mergeLoadedRefs(
  loaded: FamilyShelfPrefsRecord,
  delta: RefsByKind,
): RefsByKind {
  return {
    hidden: new Set([...loaded.hidden, ...delta.hidden]),
    favorites: new Set([...loaded.favorites, ...delta.favorites]),
  };
}

export function hasAnyRef(refs: RefsByKind): boolean {
  return refs.hidden.size > 0 || refs.favorites.size > 0;
}
