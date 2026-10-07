/** App environment from the Vite mode: "development" (`pnpm dev`) → local; "remote" (`pnpm dev:remote`,
 *  `pnpm build:dev`) → dev; anything else (`pnpm build` → "production") → prod. */

export type AppEnv = "local" | "dev" | "prod";

export function getAppEnv(): AppEnv {
  const mode = import.meta.env.MODE;
  if (mode === "development") return "local";
  if (mode === "remote") return "dev";
  return "prod";
}
