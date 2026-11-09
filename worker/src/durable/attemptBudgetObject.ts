import { DurableObject } from "cloudflare:workers";
import type { Env } from "../utils/env";
import {
  decideRefund,
  decideReserve,
  decideReset,
  type AttemptReserveResult,
  type AttemptWindowRecord,
} from "./attemptWindow";

/** The single storage key of a budget object; the value carries no id. */
const WINDOW_KEY = "window";

// One hourly attempt budget per object (`${scope}:${subject}`), used only by services/attemptBudget.ts. Each RPC decides and
// writes the sync ctx.storage.kv before its first await: docs/architecture.md → 安全措施 → 每小時額度由 Durable Object 計數.
export class AttemptBudgetObject extends DurableObject<Env> {
  /** Reserve one attempt in the current window, or refuse with the seconds left in it. */
  async reserve(max: number, windowSec: number): Promise<AttemptReserveResult> {
    const kv = this.ctx.storage.kv;
    const stored = kv.get<AttemptWindowRecord>(WINDOW_KEY);
    const { result, next } = decideReserve(stored, Date.now(), max, windowSec);
    if (next) kv.put(WINDOW_KEY, next);

    const record = next ?? stored;
    if (record) await this.ensureAlarm(record.endsAt);
    return result;
  }

  /** Return a slot reserved in `bucket` under `epoch`; a stale or unknown slot changes nothing. */
  async refund(bucket: number, epoch: number): Promise<void> {
    const kv = this.ctx.storage.kv;
    const stored = kv.get<AttemptWindowRecord>(WINDOW_KEY);
    const decision = decideRefund(stored, bucket, epoch);
    if (decision.delete) {
      kv.delete(WINDOW_KEY);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (decision.next) kv.put(WINDOW_KEY, decision.next);
  }

  /** Empty the current window and start a new epoch; no record for this window ⇒ no write. */
  async reset(windowSec: number): Promise<void> {
    const kv = this.ctx.storage.kv;
    const stored = kv.get<AttemptWindowRecord>(WINDOW_KEY);
    const next = decideReset(stored, Date.now(), windowSec);
    if (!next) return;
    kv.put(WINDOW_KEY, next);
    await this.ensureAlarm(next.endsAt);
  }

  /** Delete a finished window's record (its epoch goes with it); an unfinished one re-arms. */
  async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const stored = kv.get<AttemptWindowRecord>(WINDOW_KEY);
    if (!stored || Date.now() >= stored.endsAt) {
      kv.delete(WINDOW_KEY);
      return;
    }
    await this.ctx.storage.setAlarm(stored.endsAt);
  }

  // Never rejects: the caller's answer is already decided and stored, and a failure here must not
  // send the request to the KV fallback. Every call that leaves a record re-arms, repairing a miss.
  private async ensureAlarm(endsAt: number): Promise<void> {
    try {
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(endsAt);
      }
    } catch {
      // Not logged: the alarm only cleans up storage, and an error message could echo internals.
    }
  }
}
