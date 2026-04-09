import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "path";
import { readFileSync } from "fs";
import { devManifest } from "./plugins/devManifest";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === "serve" ? [basicSsl()] : []), devManifest()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.WORKER_PORT ?? "8787"}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
}));
