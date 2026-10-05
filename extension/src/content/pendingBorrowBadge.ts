// The floating button's pending-borrow badge (moved out of content/index.ts).
// Fetched only when the login cookie confirms the stored user (issue #275).

import browser from "webextension-polyfill";
import { MOO_ELEMENT_IDS } from "../utils/extensionContext";
import {
  DEFAULT_API_ENDPOINT,
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  API_ENDPOINT_KEY,
} from "../constants";
import { BorrowStatus } from "../api/types";
import { sanitizeBorrowRequests } from "moo-family-bookshelf-shared/borrow/validation";
import { cookieConfirmsAccount } from "./pageAccountCookie";

/**
 * Fetch pending incoming borrow requests and add a numeric badge to the
 * floating button when count > 0. Silently no-ops on any error so a
 * misconfigured backend never blocks the button from appearing.
 *
 * The request is sent only when the Readmoo account logged in on the page is
 * the stored user (issue #275); otherwise — another account, or no usable
 * login cookie — nothing is fetched and any badge already shown is removed.
 *
 * Production caller: `injectFamilyBookshelfButton` in content/index.ts.
 */
export async function updatePendingBorrowBadge(
  button: HTMLElement,
): Promise<void> {
  try {
    const stored = await browser.storage.local.get([
      USER_ID_KEY,
      FAMILY_ID_KEY,
      AUTH_TOKEN_KEY,
      API_ENDPOINT_KEY,
    ]);
    const userId = stored[USER_ID_KEY] as string | undefined;
    const familyId = stored[FAMILY_ID_KEY] as string | undefined;
    const authToken = stored[AUTH_TOKEN_KEY] as string | undefined;
    const apiEndpoint =
      (stored[API_ENDPOINT_KEY] as string | undefined) ?? DEFAULT_API_ENDPOINT;
    if (!userId || !familyId || !authToken) return;
    if (!(await cookieConfirmsAccount(userId))) {
      updateBadge(button, 0);
      return;
    }

    const url = `${apiEndpoint.replace(/\/+$/, "")}/api/family/${encodeURIComponent(familyId)}/borrow`;
    // The bare fetch is deliberate: this content script is a light IIFE bundle
    // and must not pull in ApiClient (auth-refresh, endpoint validation, dedup),
    // which lives in the code-split dialog module. Payload trust is therefore
    // delegated to `sanitizeBorrowRequests` — the same boundary
    // `ApiClient.listBorrowRequests` uses — so the two clients of this endpoint
    // cannot diverge on how they treat an untrusted (BYO) backend response.
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return;
    const json: unknown = await res.json();
    // The envelope is untrusted too: read `.data` only off a real object, then
    // let the sanitizer own array/element validation. Anything unusable degrades
    // to an empty list (badge simply absent), never a throw.
    const data =
      typeof json === "object" && json !== null && "data" in json
        ? json.data
        : undefined;
    const requests = sanitizeBorrowRequests(data);
    const pending = requests.filter(
      (r) => r.status === BorrowStatus.PENDING && r.ownerId === userId,
    ).length;
    updateBadge(button, pending);
  } catch {
    // ignore — best-effort enhancement
  }
}

/**
 * Single entry point for badge updates: attaches/replaces the badge when
 * count > 0, removes any existing badge when count <= 0. All callers (initial
 * fetch + the dialog's live count callback) go through this so the 0 case is
 * handled consistently.
 */
export function updateBadge(button: HTMLElement, count: number): void {
  if (count <= 0) {
    button.querySelector(`#${MOO_ELEMENT_IDS.button}-badge`)?.remove();
    return;
  }
  attachBadge(button, count);
}

function attachBadge(button: HTMLElement, count: number): void {
  // Remove any existing badge before re-attaching
  button.querySelector(`#${MOO_ELEMENT_IDS.button}-badge`)?.remove();

  const badge = document.createElement("span");
  badge.id = `${MOO_ELEMENT_IDS.button}-badge`;
  badge.textContent = String(count);
  badge.style.cssText = [
    "position: absolute",
    "top: -6px",
    "right: -6px",
    "min-width: 18px",
    "height: 18px",
    "padding: 0 5px",
    "border-radius: 9px",
    "background: #dc2626",
    "color: white",
    "font-size: 11px",
    "font-weight: 700",
    "line-height: 18px",
    "text-align: center",
    "box-shadow: 0 1px 3px rgba(0,0,0,0.2)",
    "pointer-events: none",
  ].join(";");
  button.style.position = "fixed"; // ensure parent positioning
  button.appendChild(badge);
}
