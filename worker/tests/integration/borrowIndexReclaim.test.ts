/**
 * SECURITY FINDING F-1, end to end: the join → borrow → leave loop must not
 * grow the family borrow index.
 *
 * THE ATTACK. `borrows:family:{familyId}` is ONE KV value (25 MiB ceiling) that
 * every member reads on every listing, and the history cap that bounds it
 * (`BORROW_HISTORY_KEEP`) is keyed per `borrowerId`. A borrowerId is free to
 * mint — anyone holding the family's sync code can join with a fresh userId.
 * So before the departure settlement existed, a sync-code holder could: join,
 * open borrow requests, leave (turning every one of them into a CANCELLED
 * record under an id that would never write again, so its group could never be
 * trimmed), and repeat. Each cycle left permanent residue and there was no
 * reclaim path — until create / PATCH / member removal all started failing on
 * an oversized value.
 *
 * WHAT THIS FILE PINS. The loop run for real, through the HTTP app, with three
 * distinct fresh userIds: after every cycle the index is back to the length it
 * had before the FIRST join, and no `borrow:{requestId}` pointer of any
 * departed id survives. The per-cycle peak is asserted too, so "back to
 * baseline" can never be satisfied by requests that were never created.
 *
 * THE NEGATIVE COMPANION IS NOT OPTIONAL. The identical loop with the departure
 * removed grows to 9 records. Without it, a broken fixture (a join that 409s, a
 * create that 400s) would make the reclaim assertion pass by producing nothing.
 *
 * NO DEV_MODE, and the native Rate Limiting bindings ARE injected: the loop has
 * to survive the pipeline a deployed Worker actually runs — the sensitive tier
 * on join, the per-userId `borrow-create` ceiling, and the hourly family-write
 * ceiling on the self-leave. See tests/helpers/rateLimitBindings.ts.
 *
 * The settlement's own rules (what is cancelled, what is purged, what survives)
 * live in tests/integration/borrowDeparture.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { createRateLimitBindings } from "../helpers/rateLimitBindings";
import {
  kvKeys,
  type BorrowRequest,
  type RawFamilyRecord,
} from "../../src/kv/schema";
import { ALICE, makeUserId } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.11";
/** How many join → borrow → leave rounds the loop performs. */
const CYCLES = 3;
/** PENDING requests each throwaway account opens before leaving. */
const REQUESTS_PER_CYCLE = 3;

let kv: KVNamespace;

/**
 * A production-shaped request: no DEV_MODE, native rate-limit bindings present,
 * one fixed caller IP.
 */
function prodRequest(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": CALLER_IP,
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, {
    KV: kv,
    ...createRateLimitBindings().bindings,
  });
}

async function createFamily(): Promise<{ familyId: string; token: string }> {
  const res = await prodRequest("POST", "/api/family", {
    userId: ALICE,
    displayName: "Alice",
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    token: json.data.authToken as string,
  };
}

/**
 * Raise the member ceiling. Setup-only KV surgery — no route exposes it — and
 * it is applied to BOTH loops so the departing and non-departing runs differ in
 * exactly one thing: whether the account leaves.
 */
async function raiseMaxMembers(familyId: string, max: number): Promise<void> {
  const raw = await kv.get<RawFamilyRecord>(kvKeys.family(familyId), "json");
  await kv.put(
    kvKeys.family(familyId),
    JSON.stringify({ ...raw, maxMembers: max }),
  );
}

async function join(familyId: string, userId: string): Promise<string> {
  const res = await prodRequest("POST", `/api/family/${familyId}/join`, {
    userId,
    displayName: "Guest",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

async function borrow(
  familyId: string,
  token: string,
  bookId: string,
): Promise<string> {
  const res = await prodRequest(
    "POST",
    `/api/family/${familyId}/borrow`,
    { bookId, bookTitle: bookId, bookAuthor: "Author", ownerId: ALICE },
    token,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as Json).data.requestId as string;
}

async function leave(
  familyId: string,
  userId: string,
  token: string,
): Promise<void> {
  const res = await prodRequest(
    "DELETE",
    `/api/family/${familyId}/member/${userId}`,
    undefined,
    token,
  );
  expect(res.status).toBe(200);
}

async function indexLength(familyId: string): Promise<number> {
  const stored = await kv.get<BorrowRequest[]>(
    kvKeys.borrowsByFamily(familyId),
    "json",
  );
  return stored?.length ?? 0;
}

/** Every `borrow:{requestId}` pointer key still present in KV. */
async function livePointerKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((k) => k.name).filter((name) => name.startsWith("borrow:"));
}

interface LoopResult {
  /** Index length before the first join. */
  baseline: number;
  /** Index length right after each cycle's borrow requests were created. */
  peaks: number[];
  /** Index length at the END of each cycle (after the departure, if any). */
  settled: number[];
  /** Every requestId the loop created. */
  createdIds: string[];
}

/**
 * Run the loop: `CYCLES` throwaway accounts, each opening
 * `REQUESTS_PER_CYCLE` PENDING requests against the family owner's books.
 */
async function runLoop(depart: boolean): Promise<LoopResult> {
  const { familyId } = await createFamily();
  await raiseMaxMembers(familyId, 1 + CYCLES);

  const baseline = await indexLength(familyId);
  const peaks: number[] = [];
  const settled: number[] = [];
  const createdIds: string[] = [];

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    // A fresh, never-seen userId per cycle — the whole point of the attack is
    // that minting one costs nothing.
    const throwaway = makeUserId(1000 + cycle);
    const token = await join(familyId, throwaway);

    for (let i = 0; i < REQUESTS_PER_CYCLE; i++) {
      createdIds.push(await borrow(familyId, token, `book-${cycle}-${i}`));
    }
    peaks.push(await indexLength(familyId));

    if (depart) await leave(familyId, throwaway, token);
    settled.push(await indexLength(familyId));
  }

  return { baseline, peaks, settled, createdIds };
}

beforeEach(() => {
  kv = createMockKV();
});

describe("Borrow index reclaim across a join → borrow → leave loop", () => {
  it("returns the index to its pre-join length after every cycle and leaves no pointer behind", async () => {
    const { baseline, peaks, settled, createdIds } = await runLoop(true);

    // Seed health: the requests really were created, so the reclaim below is
    // reclaiming something. Each cycle peaks at baseline + REQUESTS_PER_CYCLE
    // and never carries residue from an earlier cycle.
    expect(baseline).toBe(0);
    expect(createdIds).toHaveLength(CYCLES * REQUESTS_PER_CYCLE);
    expect(new Set(createdIds).size).toBe(createdIds.length);
    expect(peaks).toEqual(
      Array.from({ length: CYCLES }, () => baseline + REQUESTS_PER_CYCLE),
    );

    // F-1: no cycle leaves permanent residue in the shared index value.
    expect(settled).toEqual(Array.from({ length: CYCLES }, () => baseline));

    // …and no `borrow:{requestId}` pointer of a departed account survives
    // either: the purge deletes both halves, not just the index entry.
    expect(await livePointerKeys()).toEqual([]);
  });

  it("grows once the departure is removed", async () => {
    // The identical loop, minus the leave. Without this the assertion above
    // could be satisfied by a fixture that created nothing at all.
    const { baseline, settled } = await runLoop(false);

    expect(settled).toEqual(
      Array.from(
        { length: CYCLES },
        (_, cycle) => baseline + (cycle + 1) * REQUESTS_PER_CYCLE,
      ),
    );
    expect(await livePointerKeys()).toHaveLength(CYCLES * REQUESTS_PER_CYCLE);
  });
});
