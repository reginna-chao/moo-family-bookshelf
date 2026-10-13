import type { KvClient, Timing } from "./types.mjs";
export function createKvClient(
  options: Timing & {
    accountId: string;
    namespaceId: string;
    token: string;
    fetchImpl?: typeof fetch;
  },
): KvClient;
