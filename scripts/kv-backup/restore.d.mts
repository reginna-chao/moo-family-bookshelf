import type {
  BackupRecord,
  Confirmation,
  KvClient,
  R2Store,
  Manifest,
  Timing,
} from "./types.mjs";
export function verifyRestored(
  client: KvClient,
  records: BackupRecord[],
  timing?: Timing,
): Promise<void>;
export function runRestore(
  options: Timing & {
    client: KvClient;
    store: R2Store;
    manifestKey: string;
    accountId: string;
    sourceNamespaceId: string;
    targetNamespaceId: string;
    apply?: boolean;
    maxWrites?: number;
    confirm?: (details: Confirmation) => Promise<boolean>;
  },
): Promise<{
  applied: boolean;
  count: number;
  skipped: number;
  manifest: Manifest;
}>;
