import type { ParseArgsConfig } from "node:util";
import type { Confirmation } from "./types.mjs";
export function requireNode22(): void;
export function readConfig(env?: NodeJS.ProcessEnv): {
  accountId: string;
  namespaceId: string;
  bucket: string;
  r2Token: string;
  kvToken: string;
};
export function parseCliOptions(
  args: string[],
  options: ParseArgsConfig["options"],
): Record<string, string | boolean | undefined>;
export function parseOptions(
  args: string[],
): Record<string, string | boolean | undefined>;
export function formatRestoreSummary(result: {
  applied: boolean;
  count: number;
  skipped: number;
}): string;
export function confirmRestore(details: Confirmation): Promise<boolean>;
export function reportError(error: unknown): void;
