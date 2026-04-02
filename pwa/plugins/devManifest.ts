/**
 * Vite plugin that rewrites manifest.json for dev builds:
 * - Appends " (dev)" to name and short_name
 * - Swaps icon paths to dev/ variants
 *
 * Also copies dev/ icon files into the build output.
 * Only active when mode === "dev" (i.e., pnpm build:dev).
 */
import { readFileSync, writeFileSync, cpSync } from "fs";
import { resolve } from "path";
import type { Plugin } from "vite";

export function devManifest(): Plugin {
  let outDir: string;
  let isDev: boolean;

  return {
    name: "dev-manifest",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      isDev = config.mode === "dev" || config.mode === "development";
    },
    closeBundle() {
      if (!isDev) return;

      const manifestPath = resolve(outDir, "manifest.json");
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      } catch {
        return;
      }

      // Rename app
      if (typeof manifest.name === "string") {
        manifest.name = `${manifest.name} (dev)`;
      }
      if (typeof manifest.short_name === "string") {
        manifest.short_name = `${manifest.short_name} (dev)`;
      }

      // Swap icon paths: /icon.svg → /dev/icon.svg, etc.
      const icons = manifest.icons as Array<{ src: string }> | undefined;
      if (icons) {
        for (const icon of icons) {
          // /icon.svg → /dev/icon.svg, /icon-192.png → /dev/icon-192.png
          icon.src = icon.src.replace(/^\//, "/dev/");
        }
      }

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}
