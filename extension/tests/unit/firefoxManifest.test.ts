import { describe, it, expect } from "vitest";
import {
  toFirefoxManifest,
  GECKO_ID_AMO,
  GECKO_ID_DIRECT,
  STRICT_MIN_VERSION,
  UPDATE_URL,
  DATA_COLLECTION_PERMISSIONS,
  type FirefoxTarget,
} from "../../scripts/build-firefox-manifest";

interface BackgroundShape {
  service_worker?: string;
  type?: string;
  scripts?: string[];
}

interface GeckoShape {
  id: string;
  strict_min_version: string;
  update_url?: string;
  data_collection_permissions?: { required: string[] };
}

function makeChromeManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "墨家書櫃 | MooFamily Bookshelf",
    version: "0.0.0",
    background: {
      service_worker: "background.js",
      type: "module",
    },
    permissions: ["storage", "scripting"],
    action: { default_title: "MooFamily" },
    ...overrides,
  };
}

function geckoOf(result: ReturnType<typeof toFirefoxManifest>): GeckoShape {
  const bss = result.browser_specific_settings as Record<string, unknown>;
  return bss.gecko as GeckoShape;
}

function geckoAndroidOf(
  result: ReturnType<typeof toFirefoxManifest>,
): { strict_min_version: string } {
  const bss = result.browser_specific_settings as Record<string, unknown>;
  return bss.gecko_android as { strict_min_version: string };
}

describe("toFirefoxManifest", () => {
  const targets: FirefoxTarget[] = ["amo", "direct"];

  it.each(targets)(
    "produces shared Firefox gecko + background shape for target %s",
    (target) => {
      const chrome = makeChromeManifest();
      // toFirefoxManifest treats version as a passthrough caller-supplied value.
      const result = toFirefoxManifest(
        chrome as unknown as Parameters<typeof toFirefoxManifest>[0],
        "1.5.0",
        target,
      );

      const gecko = geckoOf(result);
      // Each target carries its own gecko.id (kept distinct to avoid an AMO
      // same-version dual-channel conflict).
      const expectedId = target === "direct" ? GECKO_ID_DIRECT : GECKO_ID_AMO;
      expect(gecko.id).toBe(expectedId);
      expect(gecko.strict_min_version).toBe(STRICT_MIN_VERSION);

      // AMO requires a data-consent declaration on all new Firefox add-ons;
      // both channels declare exactly ["websiteContent"] (book-list content
      // scraped from Readmoo; email hashed client-side, no tracking).
      expect(gecko.data_collection_permissions).toEqual({
        required: ["websiteContent"],
      });
      expect(gecko.data_collection_permissions).toEqual(
        DATA_COLLECTION_PERMISSIONS,
      );

      expect(geckoAndroidOf(result).strict_min_version).toBe(STRICT_MIN_VERSION);

      // The data-consent declaration lives under gecko, not gecko_android.
      expect(geckoAndroidOf(result)).not.toHaveProperty(
        "data_collection_permissions",
      );

      // Event page replaces the MV3 service worker for Firefox/Android.
      const background = result.background as BackgroundShape;
      expect(background.scripts).toEqual(["background.js"]);
      expect(background).not.toHaveProperty("service_worker");
      expect(background).not.toHaveProperty("type");

      // version is the caller-supplied value.
      expect(result.version).toBe("1.5.0");

      // Passthrough keys are preserved unchanged.
      expect(result.permissions).toEqual(["storage", "scripting"]);
      expect(result.action).toEqual({ default_title: "MooFamily" });
    },
  );

  it("omits gecko.update_url for the amo target", () => {
    const result = toFirefoxManifest(
      makeChromeManifest() as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "amo",
    );
    expect(geckoOf(result)).not.toHaveProperty("update_url");
  });

  it("embeds gecko.update_url for the direct target", () => {
    const result = toFirefoxManifest(
      makeChromeManifest() as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "direct",
    );
    expect(geckoOf(result).update_url).toBe(UPDATE_URL);
  });

  it("uses distinct gecko ids per target and never swaps them", () => {
    expect(GECKO_ID_AMO).not.toBe(GECKO_ID_DIRECT);

    const amo = toFirefoxManifest(
      makeChromeManifest() as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "amo",
    );
    const direct = toFirefoxManifest(
      makeChromeManifest() as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "direct",
    );
    expect(geckoOf(amo).id).toBe(GECKO_ID_AMO);
    expect(geckoOf(direct).id).toBe(GECKO_ID_DIRECT);
  });

  it("falls back to background.js when the Chrome manifest has no service_worker", () => {
    const chrome = makeChromeManifest({ background: {} });
    const result = toFirefoxManifest(
      chrome as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "amo",
    );
    expect((result.background as BackgroundShape).scripts).toEqual([
      "background.js",
    ]);
  });

  it("carries the existing service_worker filename into background.scripts", () => {
    const chrome = makeChromeManifest({
      background: { service_worker: "sw.js", type: "module" },
    });
    const result = toFirefoxManifest(
      chrome as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "amo",
    );
    expect((result.background as BackgroundShape).scripts).toEqual(["sw.js"]);
  });

  it("does not mutate the input Chrome manifest", () => {
    const chrome = makeChromeManifest();
    toFirefoxManifest(
      chrome as unknown as Parameters<typeof toFirefoxManifest>[0],
      "1.5.0",
      "direct",
    );
    const background = chrome.background as BackgroundShape;
    expect(background.service_worker).toBe("background.js");
    expect(background.type).toBe("module");
    expect(chrome).not.toHaveProperty("browser_specific_settings");
    expect(chrome.version).toBe("0.0.0");
  });
});
