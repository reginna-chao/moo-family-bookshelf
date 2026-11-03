import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

// Store-page chip script (#313): a self-contained IIFE registered at runtime by the background
// (scripting.registerContentScripts), so it is neither a manifest content script nor web-accessible.
export default defineConfig({
  envDir: resolve(__dirname, ".."),
  envPrefix: "VITE_EXTENSION_",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  publicDir: false,
  build: {
    sourcemap: process.argv.includes("--watch") ? "inline" : false,
    emptyOutDir: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        "content-store": resolve(__dirname, "src/content/storePage/index.ts"),
      },
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "content-store.js",
        assetFileNames: "assets/content-store-[name].[ext]",
      },
    },
  },
});
