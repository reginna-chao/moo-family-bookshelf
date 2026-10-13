import { createHash } from "node:crypto";
import {
  BackupError,
  MAX_ARCHIVE_BYTES,
} from "../../../scripts/kv-backup/format.mjs";
import { RunBudget } from "./runtime";

export const PART_BYTES = 5 * 1024 * 1024;

export class MultipartWriter {
  private readonly hash = createHash("sha256");
  private buffer = new Uint8Array(PART_BYTES);
  private used = 0;
  private total = 0;
  private readonly parts: R2UploadedPart[] = [];

  constructor(
    private readonly upload: R2MultipartUpload,
    private readonly budget: RunBudget,
  ) {}

  async write(bytes: Uint8Array) {
    this.total += bytes.byteLength;
    if (this.total > MAX_ARCHIVE_BYTES)
      throw new BackupError("備份超過 256 MiB 限制。");
    this.hash.update(bytes);
    for (let offset = 0; offset < bytes.byteLength;) {
      this.budget.check();
      const length = Math.min(
        PART_BYTES - this.used,
        bytes.byteLength - offset,
      );
      this.buffer.set(bytes.subarray(offset, offset + length), this.used);
      offset += length;
      this.used += length;
      if (this.used === PART_BYTES) await this.flush();
    }
  }

  private async flush() {
    const bytes = this.buffer.subarray(0, this.used);
    const part = await this.budget.call(() =>
      this.upload.uploadPart(this.parts.length + 1, bytes),
    );
    this.parts.push(part);
    this.buffer = new Uint8Array(PART_BYTES);
    this.used = 0;
  }

  async complete() {
    if (!this.total) throw new BackupError("不能完成空白備份。");
    if (this.used) await this.flush();
    await this.budget.call(() => this.upload.complete(this.parts), false);
    return { sha256: this.hash.digest("hex"), byteLength: this.total };
  }
}

export async function verifyObject(
  bucket: R2Bucket,
  key: string,
  expected: { sha256: string; byteLength: number },
  budget: RunBudget,
) {
  await budget.call(async () => {
    const object = await bucket.get(key);
    if (!object || object.size !== expected.byteLength) {
      await object?.body.cancel();
      throw new BackupError("R2 備份不存在或大小不符。");
    }
    const reader = object.body.getReader();
    const hash = createHash("sha256");
    let length = 0;
    try {
      for (;;) {
        budget.check();
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > expected.byteLength)
          throw new BackupError("R2 備份讀回超過預期大小。");
        hash.update(value);
      }
      if (
        length !== expected.byteLength ||
        hash.digest("hex") !== expected.sha256
      )
        throw new BackupError("R2 備份完整性驗證失敗。");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });
}
