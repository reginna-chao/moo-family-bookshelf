/**
 * PWA-side persistence for family-shelf update tracking (`localStorage`). The
 * tracking rules themselves are shared with the Extension in
 * `moo-family-bookshelf-shared/familyShelf/updateTracking`.
 */

export function seenKey(userId: string): string {
  return `familyBookshelfSeen:${userId}`;
}

export function chipsKey(userId: string): string {
  return `familyBookshelfChips:${userId}`;
}

export function readLocalJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeLocalJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable
  }
}
