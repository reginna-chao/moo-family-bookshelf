/**
 * Vite plugin that rewrites manifest.json for non-production builds:
 * - Appends " (dev)" to the extension name
 * - Swaps icon paths to icons-dev/ variants
 *
 * Active for modes: "development" (pnpm dev), "dev", "remote" (pnpm dev:remote, pnpm build:dev).
 * Inactive for "production" (pnpm build).
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
      outDir = config.build.outDir;
      isDev =
        config.mode === "dev" || config.mode === "development" || config.mode === "remote";
    },
    closeBundle() {
      if (!isDev) return;

      const manifestPath = resolve(outDir, "manifest.json");
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      } catch {
        // manifest.json not in this build's output (e.g., content-script config)
        return;
      }

      // Rename extension
      manifest.name = `${manifest.name as string} (dev)`;

      // Swap icons to dev variants
      const icons = manifest.icons as Record<string, string> | undefined;
      if (icons) {
        for (const size of Object.keys(icons)) {
          icons[size] = icons[size].replace("icons/", "icons-dev/");
        }
      }

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Copy dev icons into dist/icons-dev/
      const srcIconsDir = resolve(__dirname, "..", "public", "icons-dev");
      const destIconsDir = resolve(outDir, "icons-dev");
      try {
        cpSync(srcIconsDir, destIconsDir, { recursive: true });
      } catch {
        console.warn("[dev-manifest] Could not copy icons-dev/");
      }
    },
  };
}
