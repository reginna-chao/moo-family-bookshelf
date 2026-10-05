/**
 * Worker <-> shared rejoin-block duration parity tripwire (#270).
 *
 * WHY. A kicked member is refused a rejoin for as long as the Worker's
 * `kicked:{familyId}:{userId}` tombstone lives — `KICKED_TOMBSTONE_TTL_SECONDS`
 * in `src/kv/schema.ts`. The Extension and PWA tell the owner and the removed
 * member that duration in plain words ("6 小時內無法重新加入"), and that number
 * comes from `REJOIN_BLOCK_HOURS` in `shared/src/unkick/messages.ts`. The
 * Worker consumes no client copy, so nothing in the type system ties the two
 * together: change the TTL alone and every behavioural suite stays green while
 * the UI quietly states a wrong wait. This file is the only thing holding them
 * together — it pins both the constant and the strings the users actually read.
 *
 * CI REACHABILITY (.claude/rules/test.md -> "Cross-package parity tests must
 * be CI-reachable"): `.github/workflows/cicd.yml` -> `worker-check` filters on
 * BOTH `worker/**` and `shared/**`, so a drift introduced from either side
 * runs this file. Same tripwire style as `sharedEnumParity.test.ts`.
 *
 * MUTATION-CHECKED at authoring time (test.md -> "Guard tests must prove they
 * can fail"): a scratch copy of this file with `REJOIN_BLOCK_HOURS` mocked to 7,
 * and another with `KICKED_TOMBSTONE_TTL_SECONDS` mocked to 12h, each went red.
 */
import { describe, expect, it } from "vitest";
import { KICKED_TOMBSTONE_TTL_SECONDS } from "../../src/kv/schema";
import {
  REJOIN_BLOCK_HOURS,
  REJOIN_WAIT_NOTE,
  REMOVED_JOIN_TEXT,
  buildRemovedNoticeText,
} from "moo-family-bookshelf-shared/unkick/messages";

const SECONDS_PER_HOUR = 60 * 60;

describe("rejoin-block duration parity (Worker tombstone TTL <-> client copy)", () => {
  it("REJOIN_BLOCK_HOURS equals the kicked tombstone TTL in hours", () => {
    // Positive companion: a whole, non-zero hour count, so a TTL that is not
    // expressible in whole hours cannot be "matched" by a rounded client number.
    expect(Number.isInteger(REJOIN_BLOCK_HOURS)).toBe(true);
    expect(REJOIN_BLOCK_HOURS).toBeGreaterThan(0);

    expect(KICKED_TOMBSTONE_TTL_SECONDS).toBe(
      REJOIN_BLOCK_HOURS * SECONDS_PER_HOUR,
    );
  });

  it.each([
    { name: "REJOIN_WAIT_NOTE", text: REJOIN_WAIT_NOTE },
    { name: "REMOVED_JOIN_TEXT", text: REMOVED_JOIN_TEXT },
    { name: "buildRemovedNoticeText", text: buildRemovedNoticeText("小明") },
  ])("$name states the Worker's actual block duration", ({ text }) => {
    // Derived from the Worker side, so copy that hard-codes a number instead
    // of interpolating REJOIN_BLOCK_HOURS also fails when the TTL moves.
    const workerHours = KICKED_TOMBSTONE_TTL_SECONDS / SECONDS_PER_HOUR;
    expect(text).toContain(`${workerHours} 小時`);
  });
});
