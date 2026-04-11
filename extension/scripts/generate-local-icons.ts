/**
 * Generate icons-local/ PNG files from assets/brand/local/favicon.svg.
 * Produces icon-16.png, icon-48.png, icon-128.png with a light red (#FEDBDB) background.
 *
 * Run: pnpm tsx scripts/generate-local-icons.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const svgPath = resolve(root, "../assets/brand/local/favicon.svg");
const outDir = resolve(root, "public/icons-local");

const sizes = [16, 48, 128] as const;

mkdirSync(outDir, { recursive: true });

const svgContent = readFileSync(svgPath, "utf-8");

for (const size of sizes) {
  const resvg = new Resvg(svgContent, {
    fitTo: { mode: "width", value: size },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  const outPath = resolve(outDir, `icon-${size}.png`);
  writeFileSync(outPath, pngBuffer);
  console.log(`Generated: icon-${size}.png (${pngBuffer.length} bytes)`);
}

console.log("\nAll icons-local/ PNGs generated successfully.");
