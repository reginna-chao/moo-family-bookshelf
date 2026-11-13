/** Floating-button size in storage.local, a cache of the account setting (#460): any value outside the
 *  four options reads as the default. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import {
  isFloatingIconSize,
  type FloatingIconSize,
} from "moo-family-bookshelf-shared/api/accountSettingsValues";
import { FLOATING_ICON_SIZE_KEY } from "../constants";

// The type and guard live in `shared/` (the Worker checks the same four values); re-exported here.
export { isFloatingIconSize, type FloatingIconSize };

export const DEFAULT_FLOATING_ICON_SIZE: FloatingIconSize = "medium";

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
