import { describe, it, expect } from "vitest";
import { buildUpdatesManifest } from "../../scripts/build-updates-json";
import {
  GECKO_ID_AMO,
  GECKO_ID_DIRECT,
  STRICT_MIN_VERSION,
} from "../../scripts/build-firefox-manifest";

function expectedUpdateLink(version: string): string {
  return (
    `https://github.com/reginna-chao/moo-family-bookshelf/releases/download/` +
    `v${version}/moo-family-bookshelf-firefox-v${version}-direct-install.xpi`
  );
}

describe("buildUpdatesManifest", () => {
  it("keys the addons map by GECKO_ID_DIRECT with a single update entry", () => {
    const manifest = buildUpdatesManifest("1.5.0");
    // updates.json serves only the self-distributed build, so it must be keyed
    // by the direct id, never the AMO-listed id.
    expect(Object.keys(manifest.addons)).toEqual([GECKO_ID_DIRECT]);
    expect(Object.keys(manifest.addons)).not.toContain(GECKO_ID_AMO);
    expect(manifest.addons[GECKO_ID_DIRECT].updates).toHaveLength(1);
  });

  it("sets strict_min_version from the shared constant", () => {
    const manifest = buildUpdatesManifest("1.5.0");
    expect(
      manifest.addons[GECKO_ID_DIRECT].updates[0].applications.gecko
        .strict_min_version,
    ).toBe(STRICT_MIN_VERSION);
  });

  it("builds the exact direct-install update_link for v1.5.0", () => {
    const version = "1.5.0";
    const link =
      buildUpdatesManifest(version).addons[GECKO_ID_DIRECT].updates[0]
        .update_link;
    expect(link).toBe(expectedUpdateLink(version));
    expect(link.endsWith("-direct-install.xpi")).toBe(true);
    // version is interpolated twice: in the release tag and the asset name.
    expect(link.match(new RegExp(`v${version}`, "g"))).toHaveLength(2);
  });

  it.each(["1.5.0", "2.0.1"])(
    "interpolates version %s into both version field and update_link",
    (version) => {
      const entry =
        buildUpdatesManifest(version).addons[GECKO_ID_DIRECT].updates[0];
      expect(entry.version).toBe(version);
      expect(entry.update_link).toBe(expectedUpdateLink(version));
    },
  );
});
