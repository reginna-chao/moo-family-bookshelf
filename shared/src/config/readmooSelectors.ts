/** Readmoo DOM selectors and the Readmoo-owned strings the content scripts match on; re-exported by
 *  `./readmoo`, the single import entry. Checked live by extension/scripts/verify-selectors.ts. */

/** Inline style that marks the display-name line in the `#/me` profile panel. */
export const PROFILE_DISPLAY_NAME_STYLE = "font-size: 16px";

/** Title text of Readmoo's lend dialog (opened from the book-detail modal). */
export const READMOO_LEND_DIALOG_TITLE = "借出書籍";

/**
 * DOM selectors for the Readmoo web app: the library grid, the `#/me`
 * profile panel, and the page-ready, filter, search and lend flows.
 *
 * `*Legacy` entries target the pre-migration markup and exist only so the
 * extension keeps working on `read.readmoo.com`. Verified against the new site
 * on 2026-08-04; the item markup is now:
 *
 *   div.library-item
 *     div.cover-outer > div.cover-container > div.cover > a.reader-link > img.cover-img
 *     div.cover-outer > div.desktop-overlay > div.openbook-overlay
 *         ├ div.detail > span > i.mo.mo-ellipsis-horizontal
 *         ├ div.privacy#privacy-{bookId} > span
 *         └ div.menu-status > div.dropdown > button.dropdown-toggle
 *     div.info > (div.progress, div.title[title], div.star-rating)
 *
 * Two things moved: `.openbook` was renamed `.openbook-overlay` (wrapped in a
 * new `.desktop-overlay`), and `a.reader-link` moved out of the overlay into
 * `.cover`. Every other library-grid entry is valid on BOTH sites; the
 * entries from `pageSpinner` on are used unchanged on both hosts.
 */
export const READMOO_SELECTORS = {
  /** Book card container. */
  libraryItem: ".library-item",
  /** Book title, item-scoped. Read from the `title` attribute. */
  title: ".info .title[title]",
  /** Cover image, item-scoped. */
  coverImg: ".cover-img[src]",
  /** Fallback bookId source (`id="privacy-{bookId}"`), item-scoped. */
  privacyId: ".privacy[id^='privacy-']",
  /** Marks a borrowed (借入) book, item-scoped. */
  borrowedBadge: '[type="borrowed"]',
  /** Hover-revealed action overlay, item-scoped. */
  overlay: ".openbook-overlay",
  overlayLegacy: ".openbook",
  /** 「⋯」 detail button inside the overlay, item-scoped. */
  detailTrigger: ".openbook-overlay .detail span",
  detailTriggerLegacy: ".openbook .detail span",
  /** Looser detail-button match used when the inner `span` is absent. */
  detailTriggerLoose: ".openbook-overlay .detail",
  detailTriggerLooseLegacy: ".openbook .detail",
  /** Reader link carrying the bookId in its href, item-scoped. */
  readerLink: ".cover a.reader-link[href]",
  readerLinkLegacy: ".openbook a.reader-link[href]",
  /** Top navigation button (page-level). */
  topNavBtn: ".desktop-top-nav-btn",
  /** Profile panel on the `#/me` page (page-level). */
  mePanel: ".me-panel",

  /** Full-page loading spinner (page-level); the page is ready once it carries `hide`. */
  pageSpinner: "#full-page-spinner",
  pageSpinnerHidden: "#full-page-spinner.hide",
  /** Parent row of the library cards (page-level) — the fiber host lookup start when no card renders. */
  libraryRow: ".books .row",

  /** Display-name line, inside `mePanel`. */
  profileDisplayName: `div[style*='${PROFILE_DISPLAY_NAME_STYLE}']`,
  /** Inline-styled lines, inside `mePanel`; the email is the leaf one containing "@". */
  profileStyledLeaf: "div[style]",

  /** Filter icon, inside a `topNavBtn`. */
  filterIcon: "i.mo-filter",
  /** Open filter modal (page-level). */
  filterModalOpen: ".filter-modal.modal.show",
  /** 「已封存書籍」 option, inside the open filter modal. */
  archiveFilterOption: '[data-key="archive"][data-value="true"]',
  /** 「確定」 and 「清除篩選」 buttons of the filter modal (page-level). */
  filterConfirm: ".filter-modal .modal-footer .btn-primary",
  filterClear: ".filter-modal .modal-footer .btn-outline-primary",

  /** Search icon (page-level); its `topNavBtn` ancestor is the search button. */
  searchIcon: "i.mo-search",
  /** Search modal and its text input (page-level). */
  searchModal: ".search-modal",
  searchInput: ".search-modal input.form-control",
  /** Submit button, inside `searchModal`. */
  searchSubmit: "button[type='submit']",

  /** Book-detail modal (page-level), opened by `detailTrigger`. */
  bookDetailModal: ".book-detail-modal",
  /** 「借出」 menu icon, inside `bookDetailModal`. */
  lendIcon: "i.mo-envelope",
  /** Clickable ancestor of `lendIcon`, looked up with `closest()`. */
  lendButtonHost: ".cursor-pointer, button, [role='button']",
  /** Any Readmoo modal dialog (page-level) and its title. */
  dialog: "div[role='dialog']",
  dialogTitle: ".modal-title",
  /** Member option, its name and its avatar, inside the lend dialog. */
  lendMemberItem: ".list-group-item",
  lendMemberName: ".fw-bold",
  lendMemberAvatar: "img",
  /** Close button, inside a dialog. */
  dialogClose: ".btn-close",
  /** Close button of every open dialog (page-level). */
  anyDialogClose: "[role='dialog'] .btn-close",
} as const;
