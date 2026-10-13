import type { KvClient, R2Store, Manifest } from "./types.mjs";
export function runBackup(options: {
  client: KvClient;
  store: R2Store;
  accountId: string;
  namespaceId: string;
  now?: () => number;
  uuid?: () => string;
}): Promise<{ manifest: Manifest; manifestKey: string }>;
