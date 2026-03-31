/**
 * Vite config for the fiber-bridge script (IIFE, main world).
 *
 * This builds `src/content/fiber-bridge.ts` into `dist/fiber-bridge.js`
 * as a self-executing IIFE. The Content Script injects it via a
 * `<script>` tag so it runs in the page's main world context.
 *
 * Build order: runs after the main config; emptyOutDir is false.
 */
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    sourcemap: process.argv.includes("--watch") ? "inline" : false,
    emptyOutDir: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        "fiber-bridge": resolve(__dirname, "src/content/fiber-bridge.ts"),
      },
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "[name].js",
      },
    },
  },
});
