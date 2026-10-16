import type { BackupRecord, ManifestV2, RequestCounts } from "./types.mjs";
export const MAX_RESTORE_ARCHIVE_BYTES: number;
export const MAX_KEYS: number;
export const PREFIXES: string[];
export class BackupError extends Error {}
export function requireId(value: unknown): string;
export function requireObjectPath(value: unknown, suffix: string): string;
export function parseJson(text: string): unknown;
export function classifyKey(key: string): string | null;
export function validateRecordShape(record: unknown): string;
export function validateRecord(record: unknown): string;
export function encodeLine(record: BackupRecord): string;
export function decodeLine(line: string, version: 1 | 2): BackupRecord;
export function checksum(data: Buffer): string;
export function createArchive(
  records: BackupRecord[],
  options: {
    accountId: string;
    namespaceId: string;
    startedAt: string;
    completedAt: string;
    objectKey: string;
    requests?: RequestCounts;
  },
): { manifest: ManifestV2; data: Buffer };
export function validateArchive(
  manifest: unknown,
  data: Buffer,
  options: {
    accountId: string;
    namespaceId: string;
    manifestKey: string;
  },
): BackupRecord[];
export function selectRestorable(
  records: BackupRecord[],
  nowMs: number,
): BackupRecord[];
