import { BackupError } from "../../../scripts/kv-backup/format.mjs";
import type { RequestCounts } from "../../../scripts/kv-backup/types.mjs";

export interface BackupEnv {
  BACKUP_KV: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  SOURCE_ACCOUNT_ID: string;
  SOURCE_NAMESPACE_ID: string;
  HEALTHCHECKS_UUID: string;
  HEALTHCHECKS_CAPACITY_UUID: string;
  BACKUP_ENABLED?: string;
}

export interface BackupDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  uuid?: () => string;
}

// Free profile (docs/kv-backup-plan.md §3, §5, §9).
export const MAX_VALUE_BYTES = 4 * 1024 * 1024;
export const MAX_SAVED_KEYS = 5000;
export const MAX_ARCHIVE_BYTES = 15_000_000;
export const READ_BATCH_SIZE = 100;
export const MAX_INTERNAL_REQUESTS = 1000;
export const MAX_EXTERNAL_REQUESTS = 50;
export const CAPACITY_LIMITS = {
  internalRequests: 700,
  keys: 3500,
  archiveBytes: 10_000_000,
} as const;

/** Result of {@link RunBudget.attempt}: a remote failure that survived the retry is returned, not thrown. */
export type Attempt<T> = { ok: true; value: T } | { ok: false };

/**
 * True only when every capacity measure is STRICTLY below its threshold in
 * {@link CAPACITY_LIMITS}; the "容量正常" check is pinged only then.
 */
export function isWithinCapacity(measures: {
  internalRequests: number;
  count: number;
  byteLength: number;
}): boolean {
  return (
    measures.internalRequests < CAPACITY_LIMITS.internalRequests &&
    measures.count < CAPACITY_LIMITS.keys &&
    measures.byteLength < CAPACITY_LIMITS.archiveBytes
  );
}

export class RunBudget {
  private internal = 0;
  private external = 0;
  private retries = 0;
  readonly deadline: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: BackupDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.deadline = this.now() + 12 * 60_000;
  }

  check() {
    if (this.now() >= this.deadline)
      throw new BackupError("備份超過執行時間預算，未完成此次作業。");
  }

  /** Internal (KV / R2) and external (`fetch()`) requests made so far, retries included. */
  counts(): RequestCounts {
    return { internal: this.internal, external: this.external };
  }

  /** Charges one external request (a `fetch()` attempt); throws past the Free cap of 50. */
  countExternal() {
    this.check();
    if (++this.external > MAX_EXTERNAL_REQUESTS)
      throw new BackupError("備份超過對外請求上限，未完成此次作業。");
  }

  /** Runs one KV / R2 call (one internal request per attempt); a remote failure that survives the retry throws. */
  async call<T>(operation: () => Promise<T>, retry = true): Promise<T> {
    const outcome = await this.attempt(operation, retry);
    if (!outcome.ok)
      throw new BackupError("Cloudflare 備份操作失敗，已停止此次作業。");
    return outcome.value;
  }

  /**
   * Same counting and retry as {@link call}, but a remote failure that survives
   * the retry resolves to `{ ok: false }` so the caller can split a batch.
   * BackupErrors (budget, deadline, our own checks) are always rethrown.
   */
  async attempt<T>(
    operation: () => Promise<T>,
    retry = true,
  ): Promise<Attempt<T>> {
    for (let attempt = 0; ; attempt++) {
      this.check();
      if (++this.internal > MAX_INTERNAL_REQUESTS)
        throw new BackupError("備份超過內部請求上限，未完成此次作業。");
      try {
        return { ok: true, value: await operation() };
      } catch (error) {
        // Our own messages are constant and safe to keep; remote errors are not.
        if (error instanceof BackupError) throw error;
        if (!retry || attempt === 1 || this.retries >= 100)
          return { ok: false };
        this.retries++;
        await this.sleep(500);
      }
    }
  }
}

export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  budget?: RunBudget,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      budget?.check();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new BackupError("資料超過備份讀取容量限制。");
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
