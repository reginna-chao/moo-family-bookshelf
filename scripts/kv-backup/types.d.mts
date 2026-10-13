export interface BackupRecord {
  key: string;
  value: string;
  expiration?: number;
  metadata?: unknown;
}
export interface Manifest {
  version: 1;
  sourceAccountId: string;
  sourceNamespaceId: string;
  startedAt: string;
  completedAt: string;
  count: number;
  prefixCounts: Record<string, number>;
  sha256: string;
  byteLength: number;
  dataObjectPath: string;
}
export interface ListedKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}
export type ReadValues = Record<string, Omit<BackupRecord, "key"> | null>;
export interface KvClient {
  listKeys(): Promise<ListedKey[]>;
  readKeys(keys: string[]): Promise<ReadValues>;
  writeRecords(records: BackupRecord[]): Promise<void>;
}
export interface R2Store {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export interface Timing {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}
export interface Confirmation {
  targetNamespaceId: string;
  count: number;
  maxWrites: number;
}
