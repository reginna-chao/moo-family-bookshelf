import type { KvClient, R2Store } from "./types.mjs";
/** The subprocess seam: `execFile` (promisified) by default. */
export type WranglerRun = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    timeout: number;
    maxBuffer: number;
    encoding: string;
  },
) => Promise<unknown>;
export interface WranglerOptions {
  env?: NodeJS.ProcessEnv;
  run?: WranglerRun;
}
export interface WranglerTools {
  r2(bucket: string): R2Store;
  /** List-only: `readKeys` / `writeRecords` always reject. */
  kv(namespaceId: string): KvClient;
}
export function wranglerEnvironment(
  env: NodeJS.ProcessEnv,
  options: {
    accountId: string;
    token?: string;
    directory: string;
  },
): NodeJS.ProcessEnv;
export function withWrangler<T>(
  config: {
    accountId: string;
    token?: string;
  },
  action: (tools: WranglerTools) => Promise<T>,
  options?: WranglerOptions,
): Promise<T>;
/** Requires a non-blank `token`, unlike `withWrangler`. */
export function withR2Store<T>(
  config: {
    accountId: string;
    bucket: string;
    token: string;
  },
  action: (store: R2Store) => Promise<T>,
  options?: WranglerOptions,
): Promise<T>;
