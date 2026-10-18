import type { Confirmation } from "./types.mjs";
export function requireNode22(): void;
export function readConfig(env?: NodeJS.ProcessEnv): {
  accountId: string;
  namespaceId: string;
  bucket: string;
  r2Token: string;
  kvToken: string;
};
export function parseOptions(
  args: string[],
): Record<string, string | boolean | undefined>;
export function confirmRestore(details: Confirmation): Promise<boolean>;
export function reportError(error: unknown): void;
