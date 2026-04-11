/**
 * Vite plugin that rewrites manifest.json for non-production builds:
 * - Appends " (local)" or " (dev)" to the extension name
 * - Swaps icon paths to the matching variant folder
 *
 * Active for:
 *   mode === "development" → local (pnpm dev)
 *   mode === "remote"      → dev   (pnpm dev:remote, pnpm build:dev)
 * Inactive for mode === "production" (pnpm build).
 */
import { readFileSync, writeFileSync, cpSync } from "fs";
import { resolve } from "path";
import type { Plugin } from "vite";

type Variant = { label: string; iconDir: string };

const VARIANT_MAP: Partial<Record<string, Variant>> = {
  development: { label: "local", iconDir: "icons-local" },
  remote: { label: "dev", iconDir: "icons-dev" },
};

export function devManifest(): Plugin {
  let outDir: string;
  let variant: Variant | undefined;

  return {
    name: "dev-manifest",
    configResolved(config) {
      outDir = config.build.outDir;
      variant = VARIANT_MAP[config.mode];
    },
    closeBundle() {
      if (!variant) return;

      const manifestPath = resolve(outDir, "manifest.json");
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      } catch {
        // manifest.json not in this build's output (e.g., content-script config)
        return;
      }

      manifest.name = `${manifest.name as string} (${variant.label})`;

      const icons = manifest.icons as Record<string, string> | undefined;
      if (icons) {
        for (const size of Object.keys(icons)) {
          if (!icons[size].startsWith("icons/")) {
            console.warn(
              `[dev-manifest] Unexpected icon path format: ${icons[size]} — expected "icons/" prefix`,
            );
            continue;
          }
          icons[size] = icons[size].replace("icons/", `${variant.iconDir}/`);
        }
      }

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const srcIconsDir = resolve(__dirname, "..", "public", variant.iconDir);
      const destIconsDir = resolve(outDir, variant.iconDir);
      try {
        cpSync(srcIconsDir, destIconsDir, { recursive: true });
      } catch {
        console.warn(`[dev-manifest] Could not copy ${variant.iconDir}/`);
      }
    },
  };
}
