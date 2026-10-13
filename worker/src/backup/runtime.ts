import { BackupError } from "../../../scripts/kv-backup/format.mjs";

export interface BackupEnv {
  BACKUP_KV: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  SOURCE_ACCOUNT_ID: string;
  SOURCE_NAMESPACE_ID: string;
  HEALTHCHECKS_UUID: string;
  BACKUP_ENABLED?: string;
}

export interface BackupDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  uuid?: () => string;
}

export const MAX_VALUE_BYTES = 4 * 1024 * 1024;
export const MAX_SAVED_KEYS = 5000;

export class RunBudget {
  private requests = 0;
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

  async call<T>(operation: () => Promise<T>, retry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.check();
      if (++this.requests > 9000)
        throw new BackupError("備份超過請求預算，未完成此次作業。");
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof BackupError ||
          !retry ||
          attempt === 1 ||
          this.retries >= 100
        )
          throw new BackupError("Cloudflare 備份操作失敗，已停止此次作業。");
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
