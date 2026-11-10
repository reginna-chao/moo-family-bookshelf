import type { AttemptReserveResult } from "../durable/attemptWindow";
import { isDevMode, type Env } from "../utils/env";
import {
  chargePerUserRateLimit,
  deletePerUserRateLimitWindow,
  peekPerUserRateLimit,
  type PerUserRateLimitReading,
} from "../middleware/rateLimit";

/** `retryAfter` of the 429 answered while the budget's Durable Object reports itself overloaded. */
export const ATTEMPT_BUDGET_OVERLOAD_RETRY_SECONDS = 60;

/** One hourly attempt budget: `scope` + `subject` name it (object `${scope}:${subject}`, or the KV counter key). */
export interface AttemptBudgetOptions {
  subject: string;
  scope: string;
  max: number;
  windowSec: number;
}

/** Outcome of {@link reserveAttempt}: `off` (DEV_MODE), `limited` (answer 429, compare nothing), `kv` (fallback
 *  counter, charged on a wrong guess) or `durable` (a reserved slot, refunded on a correct guess). */
export type AttemptReservation =
  | { kind: "off" }
  | { kind: "limited"; retryAfter: number }
  | { kind: "kv"; reading: PerUserRateLimitReading }
  | {
      kind: "durable";
      scope: string;
      subject: string;
      bucket: number;
      epoch: number;
    };

type AttemptBudgetNamespace = NonNullable<Env["ATTEMPT_BUDGET"]>;

/** A fresh stub per call: a stub that has thrown must not be reused. */
function budgetStub(
  namespace: AttemptBudgetNamespace,
  scope: string,
  subject: string,
) {
  return namespace.get(namespace.idFromName(`${scope}:${subject}`));
}

/** True for the error a Durable Object throws when it is overloaded (`overloaded: true`). */
function isOverloaded(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { overloaded?: unknown }).overloaded === true;
}

/** The KV fallback: one read of the hourly counter, charged later by {@link settleWrongGuess} on a wrong guess. */
async function reserveOnKv(
  kv: KVNamespace,
  opts: AttemptBudgetOptions,
): Promise<AttemptReservation> {
  const reading = await peekPerUserRateLimit(kv, {
    userId: opts.subject,
    scope: opts.scope,
    max: opts.max,
    windowSec: opts.windowSec,
  });
  if (reading.verdict.limited) {
    return { kind: "limited", retryAfter: reading.verdict.retryAfter };
  }
  return { kind: "kv", reading };
}

/**
 * Reserve one attempt on an hourly budget BEFORE the secret is compared.
 *
 * - DEV_MODE ⇒ `off`, nothing counted or logged.
 * - With the `ATTEMPT_BUDGET` binding, the budget's Durable Object reserves the
 *   slot atomically, so parallel requests cannot compare more than `max` secrets
 *   in one window. An `overloaded` error ⇒ `limited` with
 *   {@link ATTEMPT_BUDGET_OVERLOAD_RETRY_SECONDS} (logs `ATTEMPT_BUDGET_OVERLOADED`);
 *   any other error ⇒ the KV fallback (logs `ATTEMPT_BUDGET_UNAVAILABLE`).
 * - No binding ⇒ the KV fallback (logs `ATTEMPT_BUDGET_BINDING_MISSING`): the
 *   previous get-then-put counter, which bounds sequential traffic only.
 *
 * Logs carry the event name only, never an error message or an id (#357). A KV
 * error on the fallback propagates. This module is the only one that touches
 * `env.ATTEMPT_BUDGET`. See docs/architecture.md → PWA 登入驗證機制 → 安全措施.
 */
export async function reserveAttempt(
  env: Env,
  opts: AttemptBudgetOptions,
): Promise<AttemptReservation> {
  if (isDevMode(env)) return { kind: "off" };

  const namespace = env.ATTEMPT_BUDGET;
  if (!namespace) {
    console.error("ATTEMPT_BUDGET_BINDING_MISSING");
    return reserveOnKv(env.KV, opts);
  }

  let result: AttemptReserveResult;
  try {
    result = await budgetStub(namespace, opts.scope, opts.subject).reserve(
      opts.max,
      opts.windowSec,
    );
  } catch (err) {
    if (isOverloaded(err)) {
      console.error("ATTEMPT_BUDGET_OVERLOADED");
      return {
        kind: "limited",
        retryAfter: ATTEMPT_BUDGET_OVERLOAD_RETRY_SECONDS,
      };
    }
    console.error("ATTEMPT_BUDGET_UNAVAILABLE");
    return reserveOnKv(env.KV, opts);
  }

  if (!result.admitted) {
    return { kind: "limited", retryAfter: result.retryAfter };
  }
  return {
    kind: "durable",
    scope: opts.scope,
    subject: opts.subject,
    bucket: result.bucket,
    epoch: result.epoch,
  };
}

/**
 * Count a wrong guess. A `durable` reservation already counted it; a `kv` one
 * writes the counter from the reading taken before the comparison (a KV error
 * propagates). `off` and `limited` do nothing.
 */
export async function settleWrongGuess(
  env: Env,
  reservation: AttemptReservation,
): Promise<void> {
  if (reservation.kind !== "kv") return;
  await chargePerUserRateLimit(env.KV, reservation.reading);
}

/**
 * Give back the slot a correct guess reserved, so a correct secret never spends
 * the budget. Only a `durable` reservation holds one. Never throws: a failed
 * refund logs `ATTEMPT_BUDGET_REFUND_FAILED` and the slot stays spent until the
 * window ends, because a correct secret must not turn into a 500.
 */
export async function releaseCorrectGuess(
  env: Env,
  reservation: AttemptReservation,
): Promise<void> {
  const namespace = env.ATTEMPT_BUDGET;
  if (reservation.kind !== "durable" || !namespace) return;
  try {
    await budgetStub(namespace, reservation.scope, reservation.subject).refund(
      reservation.bucket,
      reservation.epoch,
    );
  } catch {
    console.error("ATTEMPT_BUDGET_REFUND_FAILED");
  }
}

/** The Durable Object half of {@link resetAttemptBudget}; async so a throwing stub becomes a rejection. */
async function resetDurableWindow(
  namespace: AttemptBudgetNamespace,
  opts: Omit<AttemptBudgetOptions, "max">,
): Promise<void> {
  await budgetStub(namespace, opts.scope, opts.subject).reset(opts.windowSec);
}

/**
 * Empty the current window of an hourly budget. Always deletes the KV fallback
 * counter of this window; with the binding (and not DEV_MODE) also resets the
 * Durable Object, which starts a new epoch so a refund of an earlier slot cannot
 * land in it. No binding is not an error here and logs nothing. Both run in
 * parallel; if either fails this throws a generic error (no id in it) after both
 * have settled, and the caller decides whether to fail open.
 */
export async function resetAttemptBudget(
  env: Env,
  opts: Omit<AttemptBudgetOptions, "max">,
): Promise<void> {
  const legs: Promise<void>[] = [
    deletePerUserRateLimitWindow(env.KV, {
      userId: opts.subject,
      scope: opts.scope,
      windowSec: opts.windowSec,
    }),
  ];
  const namespace = env.ATTEMPT_BUDGET;
  if (namespace && !isDevMode(env)) {
    legs.push(resetDurableWindow(namespace, opts));
  }

  const settled = await Promise.allSettled(legs);
  if (settled.some((leg) => leg.status === "rejected")) {
    throw new Error("ATTEMPT_BUDGET_RESET_FAILED");
  }
}
