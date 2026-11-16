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
 *
 * `BorrowRequest` type parity: enums are nominal in TypeScript, so `status`
 * cannot be compared across the two declarations directly; its VALUE parity is
 * the runtime enum check. Every other field must be identical, and `status`
 * must be that side's own `BorrowStatus` on both sides. The `expectTypeOf`
 * calls are runtime no-ops — the assertion lands in `pnpm typecheck` (tsc
 * includes `tests/**`).
 *
 * Account settings (#460): the Worker's `AccountSettingsRecord` (`settings:{id}`)
 * and the clients' `AccountSettings` (`shared/src/api/accountSettings.ts`) are
 * declared separately, like `BorrowRequest`. A field renamed or added on one
 * side would make the Worker refuse every client save of it (no known field ⇒
 * `400 INVALID_SETTINGS`) or a client ignore what the Worker stores. The two
 * string unions are structurally shared (both import
 * `shared/src/api/accountSettingsValues.ts`), so only the field NAMES and the
 * nominal `BoolFlag` fields need pinning; the runtime half compares each
 * side's field list and runs both sides' rebuild over the same inputs.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  BoolFlag as WorkerBoolFlag,
  BorrowStatus as WorkerBorrowStatus,
  type AccountSettingsRecord as WorkerAccountSettings,
  type BorrowRequest as WorkerBorrowRequest,
} from "../../src/kv/schema";
import {
  ACCOUNT_SETTINGS_FIELDS as WORKER_SETTINGS_FIELDS,
  toAccountSettingsRecord,
} from "../../src/services/accountSettings";
import { BoolFlag as SharedBoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  ACCOUNT_SETTINGS_FIELDS as SHARED_SETTINGS_FIELDS,
  sanitizeAccountSettings,
  type AccountSettings as SharedAccountSettings,
} from "moo-family-bookshelf-shared/api/accountSettings";
import {
  BorrowStatus as SharedBorrowStatus,
  type BorrowRequest as SharedBorrowRequest,
} from "moo-family-bookshelf-shared/borrow/types";

type EnumObject = Record<string, string | number>;

// `{ memberName: value }`, string keys only: numeric enums carry reverse mappings (`E[0] === "FALSE"`),
// so raw `Object.entries` lists members twice and a one-sided renumbering could hide behind them.
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

      // `toEqual` is symmetric — a member added, dropped or renumbered on EITHER side fails,
      // so neither a one-sided loop nor a count check is needed on top.
      expect(workerMembers).toEqual(sharedMembers);
    },
  );

  it("BorrowRequest: the Worker record and the shared wire type carry the same fields", () => {
    // Nominal enums: `status` is each side's own `BorrowStatus` (value parity is checked above).
    // See the header → "`BorrowRequest` type parity".
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

type BoolFlagSetting = "syncArchived" | "storePageChipEnabled";

describe("Worker <-> shared account-settings parity", () => {
  it("AccountSettingsRecord and AccountSettings carry the same four optional fields", () => {
    // Nominal enums: the BoolFlag fields are each side's own enum. See the header → "Account settings".
    expectTypeOf<keyof WorkerAccountSettings>().toEqualTypeOf<
      keyof SharedAccountSettings
    >();
    expectTypeOf<Omit<WorkerAccountSettings, BoolFlagSetting>>().toEqualTypeOf<
      Omit<SharedAccountSettings, BoolFlagSetting>
    >();
    expectTypeOf<
      Required<Pick<WorkerAccountSettings, BoolFlagSetting>>
    >().toEqualTypeOf<Record<BoolFlagSetting, WorkerBoolFlag>>();
    expectTypeOf<
      Required<Pick<SharedAccountSettings, BoolFlagSetting>>
    >().toEqualTypeOf<Record<BoolFlagSetting, SharedBoolFlag>>();
  });

  it("lists the same field names, in the same order, on both sides", () => {
    expect(WORKER_SETTINGS_FIELDS.length).toBe(4);
    expect([...SHARED_SETTINGS_FIELDS]).toEqual([...WORKER_SETTINGS_FIELDS]);
  });

  it.each<{ label: string; value: unknown }>([
    {
      label: "a full valid record",
      value: {
        syncArchived: 1,
        autoSyncInterval: "monthly",
        storePageChipEnabled: 0,
        floatingIconSize: "icon",
      },
    },
    {
      label: "invalid and unknown fields next to valid ones",
      value: {
        syncArchived: true,
        autoSyncInterval: "hourly",
        storePageChipEnabled: 1,
        floatingIconSize: "small",
        theme: "dark",
      },
    },
    { label: "a null field", value: { floatingIconSize: null } },
    { label: "an array", value: [{ syncArchived: 1 }] },
    { label: "null", value: null },
  ])(
    "rebuilds $label to the same record on the Worker and the clients",
    ({ value }) => {
      // The shared rebuild warns once per dropped field set; the warning is not under test.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(sanitizeAccountSettings(value)).toEqual(
          toAccountSettingsRecord(value),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );
});
