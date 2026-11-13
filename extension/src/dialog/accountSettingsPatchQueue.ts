/** The PATCH queue of `AccountSettingsSync` (#460), split out of `accountSettingsSync.ts` for the line
 *  cap: one request at a time, each a gap after the previous reply (KV: one write per second per key). */

/** The least time between one PATCH's reply and the next PATCH leaving. */
export const ACCOUNT_SETTINGS_WRITE_GAP_MS = 1100;

/** Requests run one after another, never sooner than `ACCOUNT_SETTINGS_WRITE_GAP_MS` apart. */
export class SerialPatchQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastReplyAt: number | null = null;
  private closed = false;
  private gapWait: {
    timer: ReturnType<typeof setTimeout>;
    done: () => void;
  } | null = null;

  /** Run `send` after every earlier request settled and the gap passed; `null` when closed first. */
  enqueue<T>(send: () => Promise<T>): Promise<T | null> {
    const run = this.tail.then(() => this.sendAfterGap(send));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Send nothing more; a request waiting out the gap resolves `null` at once. */
  close(): void {
    this.closed = true;
    if (this.gapWait === null) return;
    clearTimeout(this.gapWait.timer);
    this.gapWait.done();
  }

  private async sendAfterGap<T>(send: () => Promise<T>): Promise<T | null> {
    await this.waitForGap();
    if (this.closed) return null;
    try {
      return await send();
    } finally {
      this.lastReplyAt = Date.now();
    }
  }

  private waitForGap(): Promise<void> {
    const last = this.lastReplyAt;
    const left =
      last === null ? 0 : last + ACCOUNT_SETTINGS_WRITE_GAP_MS - Date.now();
    if (left <= 0 || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.gapWait = null;
        resolve();
      };
      this.gapWait = { timer: setTimeout(done, left), done };
    });
  }
}
