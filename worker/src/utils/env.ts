/**
 * Names of the native Rate Limiting bindings, one per distinct per-minute limit
 * in use. Declared as a union so the limit -> binding table in
 * `middleware/rateLimit.ts` can index `Env` without a cast, and so adding a
 * limit is a compile error until the binding field exists here too.
 */
export type RateLimitBindingName =
  | "RATE_LIMIT_60_PER_MIN"
  | "RATE_LIMIT_30_PER_MIN"
  | "RATE_LIMIT_10_PER_MIN"
  | "RATE_LIMIT_3_PER_MIN";

export interface Env {
  KV: KVNamespace;
  DEV_MODE?: string;
  /** Auto-injected by Cloudflare with the Worker's script name. Undefined in local wrangler dev. */
  CF_WORKER?: string;

  // Native Rate Limiting bindings, OPTIONAL: an older self-hosted wrangler.toml lacks them and rateLimit.ts
  // falls back to KV. `RateLimit` is ambient (@cloudflare/workers-types >= 4.20241230, tsconfig `types`).

  /** 60 req/min: per-IP standard tier + per-userId `borrow-list`. */
  RATE_LIMIT_60_PER_MIN?: RateLimit;
  /** 30 req/min: per-userId `bookshelf` + `borrow-update`. */
  RATE_LIMIT_30_PER_MIN?: RateLimit;
  /** 10 req/min: per-IP public tier + per-userId `borrow-create`. */
  RATE_LIMIT_10_PER_MIN?: RateLimit;
  /** 3 req/min: per-IP sensitive tier, both buckets (onboarding + lookup). */
  RATE_LIMIT_3_PER_MIN?: RateLimit;
}

/** Production Worker names — DEV_MODE is forcibly ignored for these. Self-hosters deploying under a
 *  custom name: add it here for the same protection. */
const PRODUCTION_WORKER_NAMES = ["moo-family-bookshelf"];

/**
 * Runtime guard: returns true only if DEV_MODE is set AND the Worker
 * is NOT running under a production name. Prevents accidental exposure
 * if someone mistakenly adds DEV_MODE to the production environment.
 *
 * When CF_WORKER is undefined (e.g. local wrangler dev), the function
 * assumes a dev context and returns true — this is intentional, since
 * local development always needs dev-mode features like relaxed CORS.
 */
export function isDevMode(env: Env): boolean {
  if (env.DEV_MODE !== "1") return false;
  // CF_WORKER is auto-injected by Cloudflare with the Worker's script name.
  // In local wrangler dev it may be undefined — treat as dev.
  const workerName = env.CF_WORKER;
  if (!workerName) return true;
  return !PRODUCTION_WORKER_NAMES.includes(workerName);
}
