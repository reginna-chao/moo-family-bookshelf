/** Profile scraping for the Readmoo `#/me` page; re-exported by `./scraper`, the single import entry. */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";

/** Scrape user email from the Readmoo profile panel (#/me page). */
export function scrapeUserEmail(): string | null {
  const panel = document.querySelector(READMOO_SELECTORS.mePanel);
  if (!panel) return null;

  // Email is a leaf div (no child elements) containing "@".
  const candidates = panel.querySelectorAll<HTMLElement>(
    READMOO_SELECTORS.profileStyledLeaf,
  );
  for (const el of candidates) {
    if (el.childElementCount > 0) continue;
    const text = el.textContent?.trim() ?? "";
    if (text.includes("@") && text.includes(".")) {
      return text;
    }
  }
  return null;
}

/** Scrape display name from the Readmoo profile panel (#/me page). */
export function scrapeDisplayName(): string | null {
  const panel = document.querySelector(READMOO_SELECTORS.mePanel);
  if (!panel) return null;
  const nameEl = panel.querySelector<HTMLElement>(
    READMOO_SELECTORS.profileDisplayName,
  );
  return nameEl?.textContent?.trim() || null;
}
