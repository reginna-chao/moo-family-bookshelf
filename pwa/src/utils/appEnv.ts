/** App environment from the Vite build mode: `pnpm dev` → "local"; `pnpm dev:remote` and
 *  `pnpm build:dev` (MODE "remote") → "dev"; `pnpm build` → "prod". */

export type AppEnv = "local" | "dev" | "prod";

export function getAppEnv(): AppEnv {
  const mode = import.meta.env.MODE;
  if (mode === "development") return "local";
  if (mode === "remote") return "dev";
  return "prod";
}
