/**
 * Worker <-> shared enum parity tripwire (#168).
 *
 * WHY. The Worker deliberately consumes NO client wire types: `BoolFlag`,
 * `BorrowStatus` and `BorrowRequest` are declared a SECOND time in
 * `src/kv/schema.ts` (AGENTS.md -> Boolean Convention: "the two declarations
 * must stay value-identical"). That independence is a design choice, so
 * nothing in the type system ties the two sides together. Both sides put
 * these enums on the wire and into KV as bare numbers, so a member renumbered
 * or added on one side only is a silent cross-platform bug — the Extension /
 * PWA reads `CANCELLED` where the Worker wrote `REJECTED` — that every
 * behavioural suite stays green through, because each suite exercises one
 * side against itself. This file is the only thing holding them together.
 *
 * CI REACHABILITY (.claude/rules/test.md -> "Cross-package parity tests must
 * be CI-reachable"): `.github/workflows/cicd.yml` -> `worker-check` filters on
 * BOTH `worker/**` and `shared/**`, so a drift introduced from either side
 * runs this file. Same tripwire style as `kvAccessBoundary.test.ts`.
 *
 * MUTATION-CHECKED at authoring time (test.md -> "Guard tests must prove they
 * can fail"): renumbering `BorrowStatus.CANCELLED`, adding a member on one
 * side, and adding a field to the Worker `BorrowRequest` each went red.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BoolFlag as WorkerBoolFlag,
  BorrowStatus as WorkerBorrowStatus,
  type BorrowRequest as WorkerBorrowRequest,
} from "../../src/kv/schema";
import { BoolFlag as SharedBoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  BorrowStatus as SharedBorrowStatus,
  type BorrowRequest as SharedBorrowRequest,
} from "moo-family-bookshelf-shared/borrow/types";

type EnumObject = Record<string, string | number>;

/**
 * `{ memberName: value }` for a TypeScript enum, string keys only. Numeric
 * enums also carry reverse mappings (`E[0] === "FALSE"`), so a raw
 * `Object.entries` would list every member twice and a renumbering on one
 * side could hide behind the extra reverse key.
 */
function enumMembers(e: EnumObject): EnumObject {
  const members: EnumObject = {};
  for (const key of Object.keys(e)) {
    if (Number.isNaN(Number(key))) members[key] = e[key];
  }
  return members;
}

const ENUM_PAIRS: ReadonlyArray<{
  name: string;
  worker: EnumObject;
  shared: EnumObject;
}> = [
  { name: "BoolFlag", worker: WorkerBoolFlag, shared: SharedBoolFlag },
  {
    name: "BorrowStatus",
    worker: WorkerBorrowStatus,
    shared: SharedBorrowStatus,
  },
];

describe("Worker <-> shared enum parity", () => {
  it.each(ENUM_PAIRS)(
    "$name: member -> value map is identical in both directions",
    ({ worker, shared }) => {
      const workerMembers = enumMembers(worker);
      const sharedMembers = enumMembers(shared);

      // Positive companion: an enum reduced to `{}` on both sides (e.g. a
      // broken `enumMembers`) must not pass vacuously.
      expect(Object.keys(workerMembers).length).toBeGreaterThan(0);

      // `toEqual` is symmetric — a member added, dropped or renumbered on
      // EITHER side fails, so neither a one-sided loop nor a count check is
      // needed on top.
      expect(workerMembers).toEqual(sharedMembers);
    },
  );

  it("BorrowRequest: the Worker record and the shared wire type carry the same fields", () => {
    // Enums are nominal in TypeScript, so `status` cannot be compared across
    // the two declarations directly; its VALUE parity is the runtime check
    // above. Every other field must be identical, and `status` must be that
    // side's own `BorrowStatus` on both sides. Runtime no-ops — the assertion
    // lands in `pnpm typecheck` (tsc includes `tests/**`).
    expectTypeOf<Omit<WorkerBorrowRequest, "status">>().toEqualTypeOf<
      Omit<SharedBorrowRequest, "status">
    >();
    expectTypeOf<
      WorkerBorrowRequest["status"]
    >().toEqualTypeOf<WorkerBorrowStatus>();
    expectTypeOf<
      SharedBorrowRequest["status"]
    >().toEqualTypeOf<SharedBorrowStatus>();
  });
});
