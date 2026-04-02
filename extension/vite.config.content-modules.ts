/**
 * Vite config for content-script code-split modules (dialog + sync).
 *
 * Build order: the main config (vite.config.ts) runs first and clears dist/.
 * This config runs second with emptyOutDir: false so its output is additive —
 * it must NOT run standalone without the main build having populated dist/ first.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  // react() plugin is included for the content-dialog entry which uses JSX.
  // It's harmless for non-JSX entries (content-sync) and keeps the config simple.
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
      preserveEntrySignatures: "exports-only",
      input: {
        "content-dialog": resolve(__dirname, "src/dialog/main.tsx"),
        "content-sync": resolve(__dirname, "src/sync/syncBooks.ts"),
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: "assets/content-modules-[name].[ext]",
      },
    },
  },
});
