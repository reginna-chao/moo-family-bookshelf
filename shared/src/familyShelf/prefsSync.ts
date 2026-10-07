import {
  emptyRefsByKind,
  hasAnyRef,
  mergeLoadedRefs,
  toggledRef,
  type FamilyPrefKind,
  type FamilyPrefsSyncOptions,
  type FamilyShelfPrefsRecord,
  type RefsByKind,
} from "./prefsModel";

export type {
  FamilyPrefKind,
  FamilyPrefsApi,
  FamilyPrefsIo,
  FamilyPrefsSyncOptions,
  FamilyShelfPrefs,
  FamilyShelfPrefsRecord,
} from "./prefsModel";

/** Debounce window before flushing family-pref changes to the server. */
export const FLUSH_DEBOUNCE_MS = 600;

/**
 * Lifecycle of the viewer-private family-shelf preferences (v1.5.0).
 *
 * Manages BOTH the `hidden` and `favorites` ref sets (independent — a book may
 * be both) from a SINGLE personal-books load. Toggling is optimistic, and the
 * COMPLETE current arrays for every kind (full replace) are flushed to the
 * server on ONE shared debounced, user-action-triggered timer. No polling.
 *
 * Invariant: NO full-replace flush before a load has succeeded. The server
 * replaces each list wholesale, so a flush on top of a failed or unfinished
 * load would carry only this session's toggles and wipe every earlier mark
 * (issue #219). Pre-load toggles are kept as a per-kind delta that the load's
 * success path replays as ADDITIONS ONLY (`mergeLoadedRefs`) and flushes; a
 * flush due before that retries the load instead — on demand, never polled.
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
 * Adding a future kind = extend the kind helpers in `./prefsModel.ts` and the
 * flush body here, then one state + thin public wrapper trio per adapter.
 */
export class FamilyPrefsSync {
  private readonly options: FamilyPrefsSyncOptions;
  private attached = false;
  /** Set only by a load that succeeded while attached; guards the load body so it never re-clobbers pending edits. */
  private didLoad = false;
  /** A load request is in flight; a second `load()` waits on its outcome. */
  private loading = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest desired arrays per kind — read by the debounced flush. */
  private pending: RefsByKind = emptyRefsByKind();
  /** Refs toggled an odd number of times before the first successful load, per kind; replayed as additions. */
  private preLoadDelta: RefsByKind = emptyRefsByKind();

  constructor(options: FamilyPrefsSyncOptions) {
    this.options = options;
  }

  attach(): void {
    this.attached = true;
  }

  /** A toggle still inside the debounce window is flushed now rather than lost — once a
   *  load has succeeded; before that nothing is safe to send. */
  detach(): void {
    this.attached = false;
    if (this.cancelFlushTimer() && this.didLoad) this.sendFlush();
  }

  /** Single GET of the viewer's refs; a rejected or `{ error }` load changes nothing, reports the failure
   *  and is retried later. One in flight; a no-op after success, so a client change never clobbers edits. */
  load(): void {
    if (this.didLoad || this.loading) return;
    this.loading = true;
    void this.runLoad();
  }

  /** Optimistically flip `ref` in `kind`'s set and restart the debounce. */
  toggle(kind: FamilyPrefKind, ref: string): void {
    const next = toggledRef(this.pending[kind], ref);
    this.pending[kind] = next;
    if (!this.didLoad) {
      this.preLoadDelta[kind] = toggledRef(this.preLoadDelta[kind], ref);
    }
    this.options.onRefs(kind, next);
    this.scheduleFlush();
  }

  private async runLoad(): Promise<void> {
    const loaded = await this.fetchPrefs();
    this.loading = false;
    if (!this.attached) return;
    if (loaded === null) {
      this.options.onSyncFailed(true);
      return;
    }
    this.applyLoaded(loaded);
  }

  /** One GET; `null` = failed. `{ data: null }` (user has no record yet) is a valid empty load. */
  private async fetchPrefs(): Promise<FamilyShelfPrefsRecord | null> {
    try {
      const { userId, api } = this.options.getIo();
      const response = await api.getPersonalBooks(userId);
      if (response.error) return null;
      const prefs = response.data?.familyShelfPrefs;
      return { hidden: prefs?.hidden ?? [], favorites: prefs?.favorites ?? [] };
    } catch {
      return null;
    }
  }

  /** Merge pre-load toggles onto the loaded lists, publish, and save them. */
  private applyLoaded(loaded: FamilyShelfPrefsRecord): void {
    const hadDelta = hasAnyRef(this.preLoadDelta);
    this.pending = mergeLoadedRefs(loaded, this.preLoadDelta);
    this.preLoadDelta = emptyRefsByKind();
    this.didLoad = true;
    this.options.onRefs("hidden", this.pending.hidden);
    this.options.onRefs("favorites", this.pending.favorites);
    // A pre-load timer would only resend these lists and spend the PUT quota.
    this.cancelFlushTimer();
    if (!hadDelta) {
      // Clears a notice left by an earlier failed load.
      this.options.onSyncFailed(false);
      return;
    }
    this.sendFlush();
  }

  private scheduleFlush(): void {
    this.cancelFlushTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /** Clears the debounce timer; true when one was pending. */
  private cancelFlushTimer(): boolean {
    if (this.flushTimer === null) return false;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    return true;
  }

  /** Debounce target: save, or — before a successful load — retry the load. */
  private flush(): void {
    if (this.didLoad) {
      this.sendFlush();
      return;
    }
    if (this.attached) this.load();
  }

  /** Fire-and-forget full-replace flush (callers ensure `didLoad`). An `{ error }` or a throw marks the
   *  sync failed, a later success clears it; nothing is published once detached (no post-unmount set). */
  private sendFlush(): void {
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
