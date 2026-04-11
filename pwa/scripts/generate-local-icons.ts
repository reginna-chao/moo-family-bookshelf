/**
 * Generate public/local/ PNG files from public/local/icon.svg.
 * Produces icon-192.png and icon-512.png with a light red (#FEDBDB) background.
 *
 * Run: pnpm tsx scripts/generate-local-icons.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const svgPath = resolve(root, "public/local/icon.svg");
const outDir = resolve(root, "public/local");

const sizes = [192, 512] as const;

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

console.log("\nAll public/local/ PNGs generated successfully.");
