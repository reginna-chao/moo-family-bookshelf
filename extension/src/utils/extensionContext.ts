/**
 * Element IDs for MooFamily UI injected into the page.
 */
export const MOO_ELEMENT_IDS = {
  button: "moo-family-bookshelf-btn",
  dialog: "moo-family-bookshelf-dialog",
  backdrop: "moo-family-bookshelf-backdrop",
  root: "moo-family-bookshelf-root",
} as const;

/**
 * Check whether the Chrome Extension context is still valid.
 * After extension reload, old content scripts lose access to chrome.* APIs.
 */
export function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Remove all MooFamily UI elements from the page.
 */
export function cleanupMooFamilyUI(): void {
  const ids = [
    MOO_ELEMENT_IDS.button,
    MOO_ELEMENT_IDS.dialog,
    MOO_ELEMENT_IDS.backdrop,
  ];
  for (const id of ids) {
    document.getElementById(id)?.remove();
  }
}
