import type { ApiResponse, PersonalBooks } from "../api/types";

/** Debounce window before flushing family-pref changes to the server. */
export const FLUSH_DEBOUNCE_MS = 600;

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
  /**
   * Read at call time, never cached: a flush — including the one `detach()`
   * fires on unmount — must use the CURRENT userId/client, not the values
   * the controller was created with.
   */
  getIo: () => FamilyPrefsIo;
  /** Publishes a kind's current ref set (after a load, after each toggle). */
  onRefs: (kind: FamilyPrefKind, refs: Set<string>) => void;
  /** Publishes the latest flush outcome. Never called while detached. */
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
  /** True when the latest debounced flush failed (network or `{ error }`). */
  syncFailed: boolean;
}

type RefsByKind = Record<FamilyPrefKind, Set<string>>;

/**
 * Lifecycle of the viewer-private family-shelf preferences (v1.5.0).
 *
 * Manages BOTH the `hidden` and `favorites` ref sets (independent — a book may
 * be both) from a SINGLE personal-books load. Toggling is optimistic, and the
 * COMPLETE current arrays for every kind (full replace) are flushed to the
 * server on ONE shared debounced, user-action-triggered timer. No polling.
 *
 * Why a framework-agnostic controller: the Extension and the PWA used to carry
 * a copy each of this load-once / debounce / flush-on-unmount logic, which is
 * exactly the kind that drifts. `shared/` has no React dependency, so React
 * stays in each app's thin `useFamilyShelfPrefs` adapter, which only owns the
 * state setters and wires `attach` / `detach` / `load` to its effects.
 *
 * Lifecycle: `attach()` on mount, `detach()` on unmount. The pair is
 * re-entrant — React StrictMode's dev unmount→remount calls detach→attach on
 * the SAME instance, which must come back fully working, so detach never
 * disposes anything beyond the pending timer. Results that settle while
 * detached (a load, a flush outcome) are dropped.
 *
 * Adding a future kind = extend `FamilyPrefKind`, the `pending` initialiser and
 * the flush body here, then one state + thin public wrapper trio per adapter.
 */
export class FamilyPrefsSync {
  private readonly options: FamilyPrefsSyncOptions;
  private attached = false;
  /** Set only by a load that succeeded while attached; guards the load body so it never re-clobbers pending edits. */
  private didLoad = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest desired arrays per kind — read by the debounced flush. */
  private pending: RefsByKind = { hidden: new Set(), favorites: new Set() };

  constructor(options: FamilyPrefsSyncOptions) {
    this.options = options;
  }

  attach(): void {
    this.attached = true;
  }

  /**
   * Flush any pending change before clearing the timer, so a toggle made
   * inside the debounce window is not silently lost. No pending timer → no
   * request.
   */
  detach(): void {
    this.attached = false;
    if (this.flushTimer === null) return;
    this.flush();
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * Load the viewer's own refs (single GET). Tolerates errors: a failed load
   * leaves both sets empty and does NOT mark the load done, so a later call
   * retries it. Once a load has succeeded this is a no-op, so an API-client
   * identity change never clobbers unsaved optimistic edits.
   */
  load(): void {
    if (this.didLoad) return;
    void this.runLoad();
  }

  /** Optimistically flip `ref` in `kind`'s set and restart the debounce. */
  toggle(kind: FamilyPrefKind, ref: string): void {
    const next = new Set(this.pending[kind]);
    if (next.has(ref)) {
      next.delete(ref);
    } else {
      next.add(ref);
    }
    this.pending[kind] = next;
    this.options.onRefs(kind, next);
    this.scheduleFlush();
  }

  private async runLoad(): Promise<void> {
    try {
      const { userId, api } = this.options.getIo();
      const response = await api.getPersonalBooks(userId);
      if (!this.attached) return;
      const hidden = response.data?.familyShelfPrefs?.hidden ?? [];
      const favorites = response.data?.familyShelfPrefs?.favorites ?? [];
      this.pending = {
        hidden: new Set(hidden),
        favorites: new Set(favorites),
      };
      this.options.onRefs("hidden", new Set(hidden));
      this.options.onRefs("favorites", new Set(favorites));
      this.didLoad = true;
    } catch {
      // Non-critical preferences — start empty on failure.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Fire-and-forget full-replace flush.
   *
   * `updateFamilyPrefs` never throws for HTTP/network errors — it resolves with
   * an `{ error }` envelope — but we also catch defensively. Either signal marks
   * the sync as failed; a later successful flush clears it. Nothing is
   * published once detached, so the unmount flush cannot set state after
   * unmount.
   */
  private flush(): void {
    const { userId, api } = this.options.getIo();
    void api
      .updateFamilyPrefs(userId, {
        hidden: [...this.pending.hidden],
        favorites: [...this.pending.favorites],
      })
      .then((response) => {
        if (!this.attached) return;
        this.options.onSyncFailed(Boolean(response.error));
      })
      .catch(() => {
        // Optimistic local state is the session source of truth.
        if (!this.attached) return;
        this.options.onSyncFailed(true);
      });
  }
}
