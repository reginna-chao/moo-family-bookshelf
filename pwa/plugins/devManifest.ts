/**
 * Vite plugin that rewrites manifest.json and index.html for non-production builds:
 * - Appends " (local)" or " (dev)" to manifest name, short_name, and HTML <title>
 * - Swaps icon paths to the matching variant folder in both manifest and HTML
 *
 * Active for:
 *   mode === "development" → local (pnpm dev)
 *   mode === "remote"      → dev   (pnpm dev:remote, pnpm build:dev)
 * Inactive for mode === "production" (pnpm build).
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Plugin, IndexHtmlTransformResult } from "vite";

type Variant = { label: string; pathPrefix: string };

const VARIANT_MAP: Partial<Record<string, Variant>> = {
  development: { label: "local", pathPrefix: "/local/" },
  remote: { label: "dev", pathPrefix: "/dev/" },
};

export function devManifest(): Plugin {
  let outDir: string;
  let variant: Variant | undefined;

  return {
    name: "dev-manifest",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      variant = VARIANT_MAP[config.mode];
    },

    // Rewrite index.html icon links and title for non-production builds
    transformIndexHtml(html): IndexHtmlTransformResult {
      if (!variant) return html;
      const prefix = variant.pathPrefix;

      return html
        .replace(/href="\/icon\.svg"/g, `href="${prefix}icon.svg"`)
        .replace(/href="\/icon-192\.png"/g, `href="${prefix}icon-192.png"`)
        .replace(/<title>墨家書櫃<\/title>/, `<title>墨家書櫃 (${variant.label})</title>`);
    },

    closeBundle() {
      if (!variant) return;

      const manifestPath = resolve(outDir, "manifest.json");
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      } catch {
        return;
      }

      // Rename app
      if (typeof manifest.name === "string") {
        manifest.name = `${manifest.name} (${variant.label})`;
      }
      if (typeof manifest.short_name === "string") {
        manifest.short_name = `${manifest.short_name} (${variant.label})`;
      }

      // Swap icon paths: /icon.svg → /<variant>/icon.svg, etc.
      const icons = manifest.icons as Array<{ src: string }> | undefined;
      if (icons) {
        const prefix = variant.pathPrefix;
        for (const icon of icons) {
          if (!icon.src.startsWith("/")) {
            console.warn(
              `[dev-manifest] Unexpected icon src format: ${icon.src} — expected leading "/"`,
            );
            continue;
          }
          icon.src = icon.src.replace(/^\//, prefix);
        }
      }

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}
