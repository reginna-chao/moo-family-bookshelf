import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

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
        content: resolve(__dirname, "src/content/index.ts"),
      },
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "content.js",
        assetFileNames: "assets/content-[name].[ext]",
      },
    },
  },
});
