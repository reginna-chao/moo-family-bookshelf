/**
 * `createCountingKv` — the per-request KV operation counter
 * (src/middleware/kvOpCounting.ts).
 *
 * WHY THIS FILE BRINGS ITS OWN KV DOUBLE. The counter is a Proxy, and the one
 * thing a forwarding Proxy can get wrong is the RECEIVER: a real Cloudflare KV
 * binding is a host object that throws `TypeError: Illegal invocation` when one
 * of its methods runs with anything but the binding itself as `this`. An
 * earlier revision handed UNCOUNTED methods back as bare functions, so
 * `env.KV.list(...)` executed with the PROXY as `this` and blew up on workerd —
 * while the entire worker suite stayed green, because every method of
 * tests/helpers/mockKv.ts is an arrow function that ignores `this` and would
 * accept any receiver at all.
 *
 * So the double below is a class whose PROTOTYPE methods check their receiver
 * the way the platform does. mockKv.ts is deliberately left untouched: its
 * JSDoc declares it an independent oracle for the KV TTL floor, and widening it
 * into a receiver oracle too is a separate decision. Nothing here talks to KV,
 * Miniflare or the Hono app — this is the Proxy's behaviour in isolation.
 *
 * WHAT IS PINNED: every method survives the wrapper (`list` included), the
 * tally maps method → billing class exactly, an attempted-but-failed write is
 * still counted, property READS never count, and the returned promise is the
 * double's own object rather than a re-wrapped one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createCountingKv,
  type KvOpCounts,
} from "../../src/middleware/kvOpCounting";

/** One invocation the double saw, receiver verdict included. */
interface CallRecord {
  method: string;
  args: unknown[];
  thisWasOriginal: boolean;
}

/**
 * The call log is module-level rather than a field on the double on purpose: a
 * call arriving with the WRONG receiver cannot reach any per-instance state,
 * and that is exactly the call this file must be able to observe. Emptied in
 * `beforeEach`, so nothing leaks between cases.
 */
const callLog: CallRecord[] = [];

/** Value of the double's data property — read back through the Proxy below. */
const DOUBLE_LABEL = "receiver-checking-double";

/**
 * True only for the double instance itself. `originalSelf` is a plain data
 * property, so reading it off a foreign object yields `undefined` instead of
 * throwing — and reading it THROUGH the counting Proxy yields the instance
 * while `receiver` is the proxy, which is precisely the mismatch a real KV
 * binding rejects.
 */
function isOriginalReceiver(receiver: unknown): boolean {
  return (
    typeof receiver === "object" &&
    receiver !== null &&
    (receiver as { originalSelf?: unknown }).originalSelf === receiver
  );
}

/**
 * Records the call, THEN models the host-object receiver check. Recording
 * first is what lets the oracle self-test below prove the check can actually
 * fire rather than passing vacuously.
 */
function record(method: string, args: unknown[], receiver: unknown): void {
  const thisWasOriginal = isOriginalReceiver(receiver);
  callLog.push({ method, args, thisWasOriginal });
  if (!thisWasOriginal) throw new TypeError("Illegal invocation");
}

/**
 * A KV stand-in that behaves like the platform binding in the ONE dimension
 * mockKv.ts cannot: its methods live on the prototype and reject a foreign
 * `this`. It stores nothing — every method answers with a fixed value.
 */
class ReceiverCheckingKv {
  /** Identity witness for `isOriginalReceiver`. */
  readonly originalSelf: ReceiverCheckingKv;

  /** Non-function property, for the pass-through case. */
  readonly namespaceLabel = DOUBLE_LABEL;

  /**
   * Fixed return values with STABLE identities: a test can then assert the
   * Proxy handed back this very object and wrapped nothing around it.
   */
  readonly results = {
    get: Promise.resolve("v"),
    getWithMetadata: Promise.resolve({
      value: null,
      metadata: null,
      cacheStatus: null,
    }),
    put: Promise.resolve(),
    delete: Promise.resolve(),
    list: Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }),
  };

  /** When set, `put` fails — AFTER the receiver check and the recording. */
  putFailure: Error | null = null;

  constructor() {
    this.originalSelf = this;
  }

  get(...args: unknown[]): Promise<string> {
    record("get", args, this);
    return this.results.get;
  }

  getWithMetadata(...args: unknown[]): Promise<unknown> {
    record("getWithMetadata", args, this);
    return this.results.getWithMetadata;
  }

  put(...args: unknown[]): Promise<void> {
    record("put", args, this);
    // Real KV signals a failed write by REJECTING, never by throwing
    // synchronously, so the "billed even when it fails" case exercises the
    // shape production actually sees.
    if (this.putFailure !== null) return Promise.reject(this.putFailure);
    return this.results.put;
  }

  delete(...args: unknown[]): Promise<void> {
    record("delete", args, this);
    return this.results.delete;
  }

  list(...args: unknown[]): Promise<unknown> {
    record("list", args, this);
    return this.results.list;
  }
}

/** The double plus the same object typed as the binding production receives. */
function makeDouble(): { instance: ReceiverCheckingKv; kv: KVNamespace } {
  const instance = new ReceiverCheckingKv();
  // One cast at the boundary — the same move tests/helpers/mockKv.ts makes
  // when it hands its in-memory object to production code.
  return { instance, kv: instance as unknown as KVNamespace };
}

function freshCounts(): KvOpCounts {
  return { reads: 0, writes: 0, deletes: 0 };
}

const ZERO_COUNTS: KvOpCounts = { reads: 0, writes: 0, deletes: 0 };

interface MethodCase {
  /** Row label for the `it.each` title. */
  label: string;
  /** Method name the double must see. */
  method: string;
  /** Exact argument list the double must receive, in order. */
  args: unknown[];
  /** A METHOD call through the proxy, so `this` is the proxy — as in prod. */
  invoke: (kv: KVNamespace) => Promise<unknown>;
}

const METHOD_CASES: MethodCase[] = [
  {
    label: "get with a positional type argument",
    method: "get",
    args: ["k", "json"],
    invoke: (kv) => kv.get("k", "json"),
  },
  {
    label: "get with an options-object type argument",
    method: "get",
    args: ["k", { type: "json" }],
    invoke: (kv) => kv.get("k", { type: "json" }),
  },
  {
    label: "getWithMetadata",
    method: "getWithMetadata",
    args: ["k"],
    invoke: (kv) => kv.getWithMetadata("k"),
  },
  {
    label: "put with an options object",
    method: "put",
    args: ["k", "v", { expirationTtl: 60 }],
    invoke: (kv) => kv.put("k", "v", { expirationTtl: 60 }),
  },
  {
    label: "delete",
    method: "delete",
    args: ["k"],
    invoke: (kv) => kv.delete("k"),
  },
  {
    // THE row the fix turns on: `list` is UNCOUNTED, and the old trap returned
    // uncounted methods unwrapped — this call then ran with the proxy as `this`
    // and threw `TypeError: Illegal invocation` against a real binding.
    label: "list — the UNCOUNTED method",
    method: "list",
    args: [{ prefix: "k" }],
    invoke: (kv) => kv.list({ prefix: "k" }),
  },
];

beforeEach(() => {
  callLog.length = 0;
});

describe("createCountingKv", () => {
  // Awaiting the call IS the resolution assertion: a receiver the double
  // refuses surfaces here as a rejected promise and fails the case.
  it.each(METHOD_CASES)(
    "applies $label to the original namespace with the arguments verbatim",
    async ({ method, args, invoke }) => {
      const { kv } = makeDouble();
      const proxied = createCountingKv(kv, freshCounts());

      await invoke(proxied);

      expect(callLog).toEqual([{ method, args, thisWasOriginal: true }]);
    },
  );

  it("counts reads, writes and deletes by billing class and ignores list", async () => {
    const { kv } = makeDouble();
    const counts = freshCounts();
    const proxied = createCountingKv(kv, counts);

    await proxied.get("k");
    await proxied.getWithMetadata("k");
    await proxied.put("k", "v");
    await proxied.delete("k");
    await proxied.list();

    expect(counts).toEqual({ reads: 2, writes: 1, deletes: 1 });
    // Positive companion to "list moves no counter": it really did run and
    // reach the namespace, so the tally above is not green by omission.
    expect(callLog.map((call) => call.method)).toEqual([
      "get",
      "getWithMetadata",
      "put",
      "delete",
      "list",
    ]);
  });

  it("counts a write that fails, because the attempt is already billed", async () => {
    const { instance, kv } = makeDouble();
    const boom = new Error("KV put failed");
    instance.putFailure = boom;
    const counts = freshCounts();
    const proxied = createCountingKv(kv, counts);

    await expect(proxied.put("k", "v")).rejects.toBe(boom);

    expect(counts).toEqual({ reads: 0, writes: 1, deletes: 0 });
    expect(callLog).toEqual([
      { method: "put", args: ["k", "v"], thisWasOriginal: true },
    ]);
  });

  it("passes a non-function property through untouched and counts nothing", () => {
    const { kv } = makeDouble();
    const counts = freshCounts();
    const proxied = createCountingKv(kv, counts);

    expect(
      (proxied as unknown as { namespaceLabel: string }).namespaceLabel,
    ).toBe(DOUBLE_LABEL);
    expect(counts).toEqual(ZERO_COUNTS);
    expect(callLog).toEqual([]);
  });

  it("leaves the tally at zero when an inherited or symbol-keyed property is read", () => {
    const { kv } = makeDouble();
    const counts = freshCounts();
    const proxied = createCountingKv(kv, counts);

    // `constructor` IS a function, so the trap wraps it — harmless, because
    // `kvOpKindFor` returns null for it and the wrapper is never invoked.
    expect(
      typeof (proxied as unknown as { constructor: unknown }).constructor,
    ).toBe("function");
    // Reads Symbol.toStringTag (absent, so a non-function) — must not throw.
    expect(Object.prototype.toString.call(proxied)).toBe("[object Object]");

    expect(counts).toEqual(ZERO_COUNTS);
    expect(callLog).toEqual([]);
  });

  it("returns the namespace's own promise without wrapping it", async () => {
    const { instance, kv } = makeDouble();
    const proxied = createCountingKv(kv, freshCounts());

    const returned = proxied.get("k");

    expect(returned).toBe(instance.results.get);
    await expect(returned).resolves.toBe("v");
  });
});

describe("ReceiverCheckingKv (oracle self-test)", () => {
  it("throws Illegal invocation when a method runs with a foreign receiver", () => {
    const { instance } = makeDouble();
    // Exactly what the OLD trap produced for an uncounted method: a bare
    // function whose `this` is then whatever the caller invoked it on.
    const detached: (...args: unknown[]) => unknown = instance.list;

    let caught: unknown;
    try {
      detached.call({}, { prefix: "k" });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("Illegal invocation");
    expect(callLog).toEqual([
      { method: "list", args: [{ prefix: "k" }], thisWasOriginal: false },
    ]);
  });
});
