/** In-memory `ATTEMPT_BUDGET` Durable Object namespace for tests — what it models and what it
 *  cannot is in `createAttemptBudgetNamespace`'s and `createFakeDurableState`'s JSDoc. */

import { AttemptBudgetObject } from "../../src/durable/attemptBudgetObject";
import type { AttemptWindowRecord } from "../../src/durable/attemptWindow";
import type { Env } from "../../src/utils/env";

/** The namespace type production reads from `env.ATTEMPT_BUDGET`. */
export type AttemptBudgetNamespace = NonNullable<Env["ATTEMPT_BUDGET"]>;

/** The three RPCs `services/attemptBudget.ts` calls on a budget object. */
export type AttemptBudgetMethod = "reserve" | "refund" | "reset";

/** An injected RPC failure: a plain error, or the platform's `overloaded: true` error. */
export type AttemptBudgetFailure = "error" | "overloaded";

/** One RPC the namespace's stubs received, failed ones included. */
export interface AttemptBudgetCall {
  method: AttemptBudgetMethod;
  /** The object name, `${scope}:${subject}`. */
  name: string;
  args: number[];
}

/** What a fake `ctx.storage` holds and was asked to do. */
export interface FakeDurableStorage {
  /** The synchronous `ctx.storage.kv`, by key. Values are stored as structured clones. */
  kv: Map<string, unknown>;
  /** The scheduled alarm (epoch ms), or `null`. */
  alarm: number | null;
  /** Every alarm call in order: `"get"`, `"set:<ms>"`, `"delete"`. */
  alarmCalls: string[];
  /** When true, the next `getAlarm` rejects (and the flag clears). */
  failNextGetAlarm: boolean;
  /** When true, the next `setAlarm` rejects (and the flag clears). */
  failNextSetAlarm: boolean;
  /** When true, the next `deleteAlarm` rejects (and the flag clears), leaving the alarm set. */
  failNextDeleteAlarm: boolean;
}

/**
 * A fake `DurableObjectState` whose `storage` has the two surfaces
 * `AttemptBudgetObject` uses: a synchronous `kv` backed by a `Map`, and
 * `getAlarm` / `setAlarm` / `deleteAlarm` recorders. Values go through
 * `structuredClone` on put and get, as the runtime serializes them.
 *
 * Not a KV namespace, so `.claude/rules/test.md`'s one-store rule does not
 * apply. It models no input gates: the class does its read and write before its
 * first `await`, which a single JS thread already keeps atomic. The real
 * runtime's atomicity is checked by `scripts/test-attempt-budget-runtime.mjs`.
 */
export function createFakeDurableState(): {
  ctx: DurableObjectState;
  storage: FakeDurableStorage;
} {
  const storage: FakeDurableStorage = {
    kv: new Map(),
    alarm: null,
    alarmCalls: [],
    failNextGetAlarm: false,
    failNextSetAlarm: false,
    failNextDeleteAlarm: false,
  };
  const syncKv = {
    get: (key: string) => {
      const value = storage.kv.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    put: (key: string, value: unknown) => {
      storage.kv.set(key, structuredClone(value));
    },
    delete: (key: string) => storage.kv.delete(key),
  };
  const durableStorage = {
    kv: syncKv,
    getAlarm: async () => {
      storage.alarmCalls.push("get");
      if (storage.failNextGetAlarm) {
        storage.failNextGetAlarm = false;
        throw new Error("getAlarm failed");
      }
      return storage.alarm;
    },
    setAlarm: async (at: number) => {
      storage.alarmCalls.push(`set:${at}`);
      if (storage.failNextSetAlarm) {
        storage.failNextSetAlarm = false;
        throw new Error("setAlarm failed");
      }
      storage.alarm = at;
    },
    deleteAlarm: async () => {
      storage.alarmCalls.push("delete");
      if (storage.failNextDeleteAlarm) {
        storage.failNextDeleteAlarm = false;
        throw new Error("deleteAlarm failed");
      }
      storage.alarm = null;
    },
  };
  const ctx = { storage: durableStorage } as unknown as DurableObjectState;
  return { ctx, storage };
}

/** Build one real `AttemptBudgetObject` over a fresh fake state. */
export function createAttemptBudgetObject(): {
  object: AttemptBudgetObject;
  storage: FakeDurableStorage;
} {
  const { ctx, storage } = createFakeDurableState();
  return { object: new AttemptBudgetObject(ctx, {} as Env), storage };
}

/** Options of {@link createAttemptBudgetNamespace}. */
export interface AttemptBudgetNamespaceOptions {
  /** RPCs that throw instead of reaching the object; mutable later through the returned `fail`. */
  fail?: Partial<Record<AttemptBudgetMethod, AttemptBudgetFailure>>;
}

/** The namespace plus everything a test inspects or steers. */
export interface AttemptBudgetNamespaceFake {
  /** Put into the env as `ATTEMPT_BUDGET`. */
  namespace: AttemptBudgetNamespace;
  /** Every RPC in call order, failed ones included. */
  calls: AttemptBudgetCall[];
  /** Live failure switches: set `fail.reserve = "overloaded"` mid-test, `delete` to heal. */
  fail: Partial<Record<AttemptBudgetMethod, AttemptBudgetFailure>>;
  /** The record object `name` stores, or `undefined` (never created, or deleted). */
  record(name: string): AttemptWindowRecord | undefined;
  /** The fake storage of object `name`, or `undefined` before its first RPC. */
  storage(name: string): FakeDurableStorage | undefined;
}

function injectedError(
  failure: AttemptBudgetFailure,
  method: AttemptBudgetMethod,
  name: string,
): Error {
  // The message carries the object name (and so the userId): a log that echoed it would show.
  const err = new Error(`injected ${method} failure for ${name}`);
  return failure === "overloaded"
    ? Object.assign(err, { overloaded: true })
    : err;
}

/**
 * An in-memory `DurableObjectNamespace` for `AttemptBudgetObject`.
 *
 * `idFromName(name)` and `get(id)` resolve to ONE shared, real
 * `AttemptBudgetObject` per name (over {@link createFakeDurableState}), so two
 * stubs for the same budget see the same count, as on the platform. Each stub
 * method records the call, then either throws the injected failure from
 * `fail` (the object is not reached) or delegates to the object.
 *
 * Create one per test: `calls` is append-only and objects keep their records.
 */
export function createAttemptBudgetNamespace(
  opts: AttemptBudgetNamespaceOptions = {},
): AttemptBudgetNamespaceFake {
  const calls: AttemptBudgetCall[] = [];
  const fail = { ...opts.fail };
  const objects = new Map<
    string,
    { object: AttemptBudgetObject; storage: FakeDurableStorage }
  >();

  const objectFor = (name: string) => {
    let entry = objects.get(name);
    if (!entry) {
      entry = createAttemptBudgetObject();
      objects.set(name, entry);
    }
    return entry.object;
  };

  const rpc = async <T>(
    method: AttemptBudgetMethod,
    name: string,
    args: number[],
    run: (object: AttemptBudgetObject) => Promise<T>,
  ): Promise<T> => {
    calls.push({ method, name, args });
    const failure = fail[method];
    if (failure) throw injectedError(failure, method, name);
    return run(objectFor(name));
  };

  const stubFor = (name: string) => ({
    reserve: (max: number, windowSec: number) =>
      rpc("reserve", name, [max, windowSec], (o) => o.reserve(max, windowSec)),
    refund: (bucket: number, epoch: number) =>
      rpc("refund", name, [bucket, epoch], (o) => o.refund(bucket, epoch)),
    reset: (windowSec: number) =>
      rpc("reset", name, [windowSec], (o) => o.reset(windowSec)),
  });

  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => stubFor(id.name),
  } as unknown as AttemptBudgetNamespace;

  return {
    namespace,
    calls,
    fail,
    record: (name) =>
      objects.get(name)?.storage.kv.get("window") as
        AttemptWindowRecord | undefined,
    storage: (name) => objects.get(name)?.storage,
  };
}
