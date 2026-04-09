export interface Env {
  KV: KVNamespace;
  DEV_MODE?: string;
  /** Auto-injected by Cloudflare with the Worker's script name. Undefined in local wrangler dev. */
  CF_WORKER?: string;
}

/**
 * Production Worker names — DEV_MODE is forcibly ignored for these.
 *
 * Self-hosters: if you deploy under a custom Worker name and want the same
 * protection, add your production Worker name to this list.
 */
const PRODUCTION_WORKER_NAMES = [
  "moo-family-bookshelf",
];

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
