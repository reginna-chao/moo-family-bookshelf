/** The two string-valued account settings (#460) and their guards, shared by the Worker's boundary check and both
 *  clients. Import-free on purpose: the Worker pulls it in next to its own `BoolFlag`. */

/** Auto-sync frequencies, in the order the settings screen lists them. */
export const AUTO_SYNC_INTERVALS = [
  "daily",
  "weekly",
  "monthly",
  "never",
] as const;

/** User-configurable auto-sync frequency. */
export type AutoSyncInterval = (typeof AUTO_SYNC_INTERVALS)[number];

/** Floating family-shelf button sizes, in the order the settings screen lists them. */
export const FLOATING_ICON_SIZES = [
  "small",
  "medium",
  "large",
  "icon",
] as const;

/** Floating family-shelf button size. */
export type FloatingIconSize = (typeof FLOATING_ICON_SIZES)[number];

/** Type guard for {@link AutoSyncInterval}: exactly one of the four strings. */
export function isAutoSyncInterval(v: unknown): v is AutoSyncInterval {
  return (
    typeof v === "string" &&
    (AUTO_SYNC_INTERVALS as readonly string[]).includes(v)
  );
}

/** Type guard for {@link FloatingIconSize}: exactly one of the four strings. */
export function isFloatingIconSize(v: unknown): v is FloatingIconSize {
  return (
    typeof v === "string" &&
    (FLOATING_ICON_SIZES as readonly string[]).includes(v)
  );
}
