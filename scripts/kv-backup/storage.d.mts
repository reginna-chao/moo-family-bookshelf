import type { R2Store } from "./types.mjs";
export function wranglerEnvironment(
  env: NodeJS.ProcessEnv,
  options: {
    accountId: string;
    token: string;
    directory: string;
  },
): NodeJS.ProcessEnv;
export function withR2Store<T>(
  config: {
    accountId: string;
    bucket: string;
    token: string;
  },
  action: (store: R2Store) => Promise<T>,
  options?: {
    env?: NodeJS.ProcessEnv;
    run?: (
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
  },
): Promise<T>;
