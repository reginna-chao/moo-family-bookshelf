/**
 * Vite plugin that rewrites manifest.json and index.html for dev builds:
 * - Appends " (dev)" to manifest name and short_name
 * - Swaps icon paths to dev/ variants in both manifest and HTML
 * - Updates HTML <title> with (dev) suffix
 *
 * Only active when mode === "dev" or "development" (i.e., pnpm build:dev / pnpm dev).
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Plugin, IndexHtmlTransformResult } from "vite";

export function devManifest(): Plugin {
  let outDir: string;
  let isDev: boolean;

  return {
    name: "dev-manifest",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      isDev = config.mode === "dev" || config.mode === "development";
    },

    // Rewrite index.html icon links and title for dev builds
    transformIndexHtml(html): IndexHtmlTransformResult {
      if (!isDev) return html;

      return html
        .replace(/href="\/icon\.svg"/g, 'href="/dev/icon.svg"')
        .replace(/href="\/icon-192\.png"/g, 'href="/dev/icon-192.png"')
        .replace(/<title>墨家書櫃<\/title>/, "<title>墨家書櫃 (dev)</title>");
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
          icon.src = icon.src.replace(/^\//, "/dev/");
        }
      }

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}
