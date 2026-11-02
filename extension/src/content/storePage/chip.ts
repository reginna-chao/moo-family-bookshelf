/** The store-page chip: a host after the book title, the chip in a CLOSED Shadow Root (page scripts
 *  cannot reach its nodes) and `user-select: none` (nor select its text); `textContent` only. */

import { READMOO_STORE_SELECTORS } from "moo-family-bookshelf-shared/config/readmooStore";
import {
  formatStoreChipText,
  formatStoreStaleText,
} from "moo-family-bookshelf-shared/storePage/index";
import type { StoreChipState } from "./eligibility";

export const STORE_CHIP_HOST_ID = "moo-store-chip-host";

// Lives inside the shadow root, so it can neither restyle Readmoo nor be restyled by it.
const STORE_CHIP_CSS = `:host {
  display: block;
  margin: 6px 0;
}
.moo-store-chip {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 13px;
  line-height: 1.6;
  user-select: none;
  -webkit-user-select: none;
}
.moo-store-chip--stale {
  background: #f3f4f6;
  color: #4b5563;
}`;

interface MountedChip {
  host: HTMLElement;
  // The closed root is only reachable through this reference; `host.shadowRoot` is null.
  root: ShadowRoot;
  chip: HTMLElement;
}

let mounted: MountedChip | null = null;

/** Place the host after the title, or at the end of the meta box; false when neither exists. */
function placeHost(host: HTMLElement): boolean {
  const title = document.querySelector(READMOO_STORE_SELECTORS.bookTitle);
  if (title) {
    title.after(host);
    return true;
  }
  const metaBox = document.querySelector(READMOO_STORE_SELECTORS.bookMetaBox);
  if (!metaBox) return false;
  metaBox.appendChild(host);
  return true;
}

/** A new host + closed root holding the style and an empty chip, placed on the page; null when unplaceable. */
function mountChip(): MountedChip | null {
  const host = document.createElement("div");
  host.id = STORE_CHIP_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STORE_CHIP_CSS;
  const chip = document.createElement("div");
  root.append(style, chip);
  if (!placeHost(host)) return null;
  return { host, root, chip };
}

/** The mounted chip, re-created when the page dropped the host; null when it cannot be placed. */
function ensureChip(): HTMLElement | null {
  if (mounted?.host.isConnected) return mounted.chip;
  removeStoreChip();
  mounted = mountChip();
  return mounted?.chip ?? null;
}

/** Show the names, show the stale hint, or remove the chip, as `state` says. */
export function renderStoreChip(state: StoreChipState): void {
  if (state.kind === "none") {
    removeStoreChip();
    return;
  }
  const chip = ensureChip();
  if (!chip) return;
  if (state.kind === "stale") {
    chip.className = "moo-store-chip moo-store-chip--stale";
    chip.textContent = formatStoreStaleText();
    return;
  }
  chip.className = "moo-store-chip";
  chip.textContent = formatStoreChipText(state.names);
}

/** Remove the host (ours, or a stray one with our id) and forget the root. */
export function removeStoreChip(): void {
  mounted?.host.remove();
  mounted = null;
  document.getElementById(STORE_CHIP_HOST_ID)?.remove();
}
