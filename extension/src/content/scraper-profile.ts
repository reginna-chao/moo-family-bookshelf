/** Profile scraping for the Readmoo `#/me` page; re-exported by `./scraper`, the single import entry. */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";
import { isEmailShaped } from "moo-family-bookshelf-shared/account/emailShape";

/** Scrape user email from the Readmoo profile panel (#/me page). */
export function scrapeUserEmail(): string | null {
  const panel = document.querySelector(READMOO_SELECTORS.mePanel);
  if (!panel) return null;

  // Email is a leaf div (no child elements) shaped like an email. More than one distinct
  // candidate means we cannot tell which is the account's (#368), so none is returned.
  const emails = new Set<string>();
  for (const el of panel.querySelectorAll<HTMLElement>("div[style]")) {
    if (el.childElementCount > 0) continue;
    const text = el.textContent?.trim() ?? "";
    if (isEmailShaped(text)) emails.add(text);
  }
  const [email] = emails;
  return emails.size === 1 && email !== undefined ? email : null;
}

/** Scrape display name from the Readmoo profile panel (#/me page). */
export function scrapeDisplayName(): string | null {
  const panel = document.querySelector(READMOO_SELECTORS.mePanel);
  if (!panel) return null;
  const nameEl = panel.querySelector<HTMLElement>(
    "div[style*='font-size: 16px']",
  );
  return nameEl?.textContent?.trim() || null;
}
