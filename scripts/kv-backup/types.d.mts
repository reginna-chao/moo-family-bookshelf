export interface BackupRecord {
  key: string;
  value: string;
  expiration?: number;
  metadata?: unknown;
}
export interface RequestCounts {
  internal: number;
  external: number;
}
interface ManifestBase {
  sourceAccountId: string;
  sourceNamespaceId: string;
  startedAt: string;
  completedAt: string;
  count: number;
  prefixCounts: Record<string, number>;
  byteLength: number;
  dataObjectPath: string;
}
/** Read-only legacy format: string values, SHA-256 of the whole archive. */
export interface ManifestV1 extends ManifestBase {
  version: 1;
  sha256: string;
}
/** Written by the backup Worker: raw JSON values, per-line byte lengths. */
export interface ManifestV2 extends ManifestBase {
  version: 2;
  lineLengths: number[];
  objectSize: number;
  requests: RequestCounts;
}
export type Manifest = ManifestV1 | ManifestV2;
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
