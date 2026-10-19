import type { WranglerRun } from "./kv-backup/storage.mjs";
export function main(
  args?: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    run?: WranglerRun;
    configPath?: string;
    log?: (line: string) => void;
  },
): Promise<void>;
