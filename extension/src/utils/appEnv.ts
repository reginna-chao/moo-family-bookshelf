/**
 * App environment detection based on Vite build mode.
 *
 * - pnpm dev          → MODE = "development" → "local"
 * - pnpm build:dev    → MODE = "dev"         → "dev"
 * - pnpm build        → MODE = "production"  → "prod"
 */

export type AppEnv = "local" | "dev" | "prod";

export function getAppEnv(): AppEnv {
  const mode = import.meta.env.MODE;
  if (mode === "development") return "local";
  if (mode === "dev") return "dev";
  return "prod";
}
