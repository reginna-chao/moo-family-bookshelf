import type { BackupRecord, Manifest } from "./types.mjs";
export const MAX_ARCHIVE_BYTES: number;
export const MAX_KEYS: number;
export const PREFIXES: string[];
export class BackupError extends Error {}
export function requireId(value: unknown): string;
export function requireObjectPath(value: unknown, suffix: string): string;
export function parseJson(text: string): unknown;
export function classifyKey(key: string): string | null;
export function validateRecord(record: unknown): string;
export function checksum(data: Buffer): string;
export function createArchive(
  records: BackupRecord[],
  options: {
    accountId: string;
    namespaceId: string;
    startedAt: string;
    completedAt: string;
    objectKey: string;
  },
): { manifest: Manifest; data: Buffer };
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
