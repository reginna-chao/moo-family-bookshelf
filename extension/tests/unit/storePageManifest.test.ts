import { describe, it, expect } from "vitest";
import manifest from "../../public/manifest.json";
import { READMOO_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmoo";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";
import {
  STRICT_MIN_VERSION,
  toFirefoxManifest,
} from "../../scripts/build-firefox-manifest";
import { checkManifest } from "../../scripts/verify-build-checks";

/**
 * The shipped `public/manifest.json` for the store-page chip (#313). The store pages are an OPTIONAL
 * host permission, asked for on the options page; the always-on host list, the content scripts and the
 * web-accessible resources stay exactly the two web-app hosts. `content-store.js` is registered at
 * runtime through `scripting`, and the options page is opened by the browser itself, so neither may be
 * web-accessible (a Readmoo page could otherwise load or frame them).
 *
 * The toolbar icon opens the options page through `action.onClicked`, which never fires while the
 * action declares a `default_popup` — so the absence of a popup is pinned here too.
 *
 * Firefox: `optional_host_permissions` arrives in Firefox 128, so a Firefox build keeping the field must
 * not advertise an older `strict_min_version` (desktop and Android alike).
 */

type ShippedManifest = typeof manifest & {
  action: Record<string, unknown>;
};

const shipped = manifest as ShippedManifest;

describe("public/manifest.json (store-page chip)", () => {
  it("asks for the store book pages only as an optional host permission", () => {
    expect(shipped.optional_host_permissions).toEqual([
      ...READMOO_STORE_MATCH_PATTERNS,
    ]);
    expect(shipped.host_permissions).toEqual([...READMOO_MATCH_PATTERNS]);
  });

  it("keeps the store pattern out of every always-on list", () => {
    const alwaysOn = [
      ...shipped.host_permissions,
      ...shipped.content_scripts.flatMap((entry) => entry.matches),
      ...shipped.web_accessible_resources.flatMap((entry) => entry.matches),
    ];
    for (const pattern of READMOO_STORE_MATCH_PATTERNS) {
      expect(alwaysOn).not.toContain(pattern);
    }
  });

  it("declares the scripting permission for the runtime registration", () => {
    expect(shipped.permissions).toContain("scripting");
  });

  it("opens options.html in a tab", () => {
    expect(shipped.options_ui).toEqual({
      page: "options.html",
      open_in_tab: true,
    });
  });

  it("has no toolbar popup, so a click reaches action.onClicked", () => {
    expect(shipped.action).not.toHaveProperty("default_popup");
  });

  it.each(["options.html", "content-store.js"])(
    "does not make %s web-accessible",
    (file) => {
      const resources = shipped.web_accessible_resources.flatMap(
        (entry) => entry.resources,
      );
      expect(resources).not.toContain(file);
      // Positive companion: the list read here is the real one.
      expect(resources).toContain("secure-frame.html");
    },
  );

  it("passes every verify-build manifest check", () => {
    expect(checkManifest(shipped)).toEqual([]);
  });
});

describe("Firefox build of the shipped manifest", () => {
  it.each(["amo", "direct"] as const)(
    "keeps the optional permission and options page, with a floor of 128+ (%s)",
    (target) => {
      const firefox = toFirefoxManifest(
        shipped as unknown as Parameters<typeof toFirefoxManifest>[0],
        "1.0.0",
        target,
      ) as Record<string, unknown>;

      expect(firefox.optional_host_permissions).toEqual([
        ...READMOO_STORE_MATCH_PATTERNS,
      ]);
      expect(firefox.options_ui).toEqual(shipped.options_ui);
      const settings = firefox.browser_specific_settings as Record<
        string,
        { strict_min_version: string }
      >;
      for (const key of ["gecko", "gecko_android"]) {
        expect(settings[key].strict_min_version).toBe(STRICT_MIN_VERSION);
      }
      expect(Number.parseFloat(STRICT_MIN_VERSION)).toBeGreaterThanOrEqual(128);
    },
  );
});
