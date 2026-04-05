import { useSyncExternalStore } from "react";

interface QueryEntry {
  mql: MediaQueryList;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => boolean;
}

// Cache assumes a small, finite set of static query strings (e.g. breakpoints).
const cache = new Map<string, QueryEntry>();

function getEntry(query: string): QueryEntry | null {
  if (typeof window === "undefined") return null;
  let entry = cache.get(query);
  if (!entry) {
    const mql = window.matchMedia(query);
    entry = {
      mql,
      subscribe: (cb: () => void) => {
        mql.addEventListener("change", cb);
        return () => mql.removeEventListener("change", cb);
      },
      getSnapshot: () => mql.matches,
    };
    cache.set(query, entry);
  }
  return entry;
}

// Defensive fallback; Chrome Extension always has window.
const noopSubscribe = () => () => {};
const ssrSnapshot = () => false;

export function useMediaQuery(query: string): boolean {
  const entry = getEntry(query);
  return useSyncExternalStore(
    entry?.subscribe ?? noopSubscribe,
    entry?.getSnapshot ?? ssrSnapshot,
  );
}
