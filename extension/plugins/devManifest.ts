/**
 * Vite plugin that rewrites manifest.json for non-production builds:
 * - Appends " (local)" or " (dev)" to the extension name (idempotent)
 * - Swaps icon paths in both manifest.icons and manifest.action.default_icon
 *   to the matching variant folder
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

const KNOWN_LABELS = Object.values(VARIANT_MAP)
  .filter((v): v is Variant => v !== undefined)
  .map((v) => v.label);

const STRIP_SUFFIX_PATTERN = new RegExp(
  `\\s\\((?:${KNOWN_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\)$`,
);

function rewriteIconPaths(
  icons: Record<string, string> | undefined,
  iconDir: string,
  fieldName: string,
): void {
  if (!icons) return;
  for (const size of Object.keys(icons)) {
    if (!icons[size].startsWith("icons/")) {
      console.warn(
        `[dev-manifest] Unexpected icon path format in ${fieldName}: ${icons[size]} — expected "icons/" prefix`,
      );
      continue;
    }
    icons[size] = icons[size].replace("icons/", `${iconDir}/`);
  }
}

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
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        // manifest.json not in this build's output (e.g., content-script config)
        return;
      }

      const baseName = (manifest.name as string).replace(
        STRIP_SUFFIX_PATTERN,
        "",
      );
      manifest.name = `${baseName} (${variant.label})`;

      rewriteIconPaths(
        manifest.icons as Record<string, string> | undefined,
        variant.iconDir,
        "manifest.icons",
      );

      const action = manifest.action as
        { default_icon?: Record<string, string> } | undefined;
      rewriteIconPaths(
        action?.default_icon,
        variant.iconDir,
        "manifest.action.default_icon",
      );

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
