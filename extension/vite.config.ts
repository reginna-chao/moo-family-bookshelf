import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";
import { devManifest } from "./plugins/devManifest";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  envDir: resolve(__dirname, ".."),
  envPrefix: "VITE_EXTENSION_",
  plugins: [react(), devManifest()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    sourcemap: process.argv.includes("--watch") ? "inline" : false,
    // In watch mode (pnpm dev), don't clear dist/ — it breaks Chrome extension
    // reload because files disappear momentarily during rebuild.
    // Full builds (pnpm build) run verify-build.ts afterwards anyway.
    emptyOutDir: !process.argv.includes("--watch"),
    outDir: "dist",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/dialog/index.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
