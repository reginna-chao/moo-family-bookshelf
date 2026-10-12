/** Floating-button size, read/written DIRECTLY in storage.local (a local-only device preference): any
 *  value outside the four options reads as the default. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import { FLOATING_ICON_SIZE_KEY } from "../constants";

export type FloatingIconSize = "small" | "medium" | "large" | "icon";

export const DEFAULT_FLOATING_ICON_SIZE: FloatingIconSize = "medium";

/** Type guard for FloatingIconSize */
export function isFloatingIconSize(v: unknown): v is FloatingIconSize {
  return v === "small" || v === "medium" || v === "large" || v === "icon";
}

export async function readFloatingIconSize(): Promise<FloatingIconSize> {
  const result = await browser.storage.local.get([FLOATING_ICON_SIZE_KEY]);
  const stored = result[FLOATING_ICON_SIZE_KEY];
  return isFloatingIconSize(stored) ? stored : DEFAULT_FLOATING_ICON_SIZE;
}

export async function writeFloatingIconSize(
  size: FloatingIconSize,
): Promise<void> {
  await browser.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: size });
}
