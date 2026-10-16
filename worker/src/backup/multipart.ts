import { BackupError } from "../../../scripts/kv-backup/format.mjs";
import { MAX_ARCHIVE_BYTES, RunBudget } from "./runtime";

export const PART_BYTES = 5 * 1024 * 1024;

export class MultipartWriter {
  private buffer = new Uint8Array(PART_BYTES);
  private used = 0;
  private total = 0;
  private readonly parts: R2UploadedPart[] = [];
  private isCompleted = false;

  constructor(
    private readonly upload: R2MultipartUpload,
    private readonly budget: RunBudget,
  ) {}

  /** True once R2 has committed the object, so cleanup must delete it rather than abort. */
  get completed() {
    return this.isCompleted;
  }

  async write(bytes: Uint8Array) {
    this.total += bytes.byteLength;
    if (this.total > MAX_ARCHIVE_BYTES)
      throw new BackupError("備份超過 15 MB 限制。");
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

  /** Commits the upload; `objectSize` is the size R2 reports for the committed object. */
  async complete() {
    if (!this.total) throw new BackupError("不能完成空白備份。");
    if (this.used) await this.flush();
    const object = await this.budget.call(
      () => this.upload.complete(this.parts),
      false,
    );
    this.isCompleted = true;
    return { byteLength: this.total, objectSize: object.size };
  }
}
