import browser from "webextension-polyfill";

/**
 * Element IDs for MooFamily UI injected into the page.
 */
export const MOO_ELEMENT_IDS = {
  button: "moo-family-bookshelf-btn",
  /**
   * Light-DOM host that owns the dialog's Shadow Root. The backdrop, dialog,
   * close icon, and React mount point all live INSIDE this host's shadow tree,
   * isolated from Readmoo's page styles. Toggle/close paths remove the host.
   */
  host: "moo-family-bookshelf-host",
  dialog: "moo-family-bookshelf-dialog",
  backdrop: "moo-family-bookshelf-backdrop",
  root: "moo-family-bookshelf-root",
  closeIcon: "moo-family-bookshelf-close",
} as const;

/**
 * Check whether the Chrome Extension context is still valid.
 * After extension reload, old content scripts lose access to chrome.* APIs.
 */
export function isExtensionContextValid(): boolean {
  try {
    return !!browser.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Remove all MooFamily UI elements from the page.
 */
export function cleanupMooFamilyUI(): void {
  // The dialog + backdrop live inside the shadow host, so removing the host
  // removes them too. The button remains in the light DOM and is removed
  // separately.
  const ids = [MOO_ELEMENT_IDS.button, MOO_ELEMENT_IDS.host];
  for (const id of ids) {
    document.getElementById(id)?.remove();
  }
}
