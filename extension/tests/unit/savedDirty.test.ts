import { describe, it, expect } from "vitest";
import { savedDirtyIds } from "moo-family-bookshelf-shared/personal/savedDirty";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";

/**
 * #250: a save's success path must clear only the send-time unsaved ids the
 * save really saved. A share toggle made while the request was in flight stays
 * unsaved — the server holds the flag that was sent, not the one on screen.
 * The helper is shared by the Extension and the PWA; shared/ has no test
 * script, so its rules are pinned here.
 */

/** Minimal entry — the helper reads only `{ bookId, isShared }`. */
const b = (bookId: string, isShared: BoolFlag = BoolFlag.FALSE) => ({
  bookId,
  isShared,
});

describe("savedDirtyIds", () => {
  it.each([
    {
      label: "same flag on screen as sent → cleared",
      sent: [b("a", BoolFlag.TRUE)],
      latest: [b("a", BoolFlag.TRUE)],
      expected: ["a"],
    },
    {
      label: "flag on screen differs from the sent one → stays unsaved",
      sent: [b("a", BoolFlag.TRUE)],
      latest: [b("a", BoolFlag.FALSE)],
      expected: [],
    },
    {
      label: "gone from the screen list → cleared",
      sent: [b("a", BoolFlag.TRUE)],
      latest: [b("other")],
      expected: ["a"],
    },
    {
      label: "absent from both lists → cleared (nothing left on screen)",
      sent: [b("other")],
      latest: [b("other")],
      expected: ["a"],
    },
    {
      label: "not in the sent list but on screen → stays unsaved",
      sent: [b("other")],
      latest: [b("a", BoolFlag.TRUE), b("other")],
      expected: [],
    },
  ])("handles a sent dirty id: $label", ({ sent, latest, expected }) => {
    expect(savedDirtyIds(sent, latest, new Set(["a"]))).toEqual(expected);
  });

  it("never returns an id outside the send-time dirty set", () => {
    // b and c are on screen with flags equal to the sent ones, but were not
    // dirty when the save went out — they are not the caller's to clear.
    const sent = [b("a", BoolFlag.TRUE), b("b"), b("c", BoolFlag.TRUE)];
    const latest = [b("a", BoolFlag.TRUE), b("b"), b("c", BoolFlag.TRUE)];

    expect(savedDirtyIds(sent, latest, new Set(["a"]))).toEqual(["a"]);
  });

  it("splits a mixed dirty set: saved ids cleared, mid-save edits kept", () => {
    const sent = [
      b("kept-same", BoolFlag.TRUE),
      b("flipped", BoolFlag.TRUE),
      b("dropped", BoolFlag.TRUE),
      b("unshared"),
    ];
    const latest = [
      b("kept-same", BoolFlag.TRUE),
      b("flipped", BoolFlag.FALSE),
      b("unshared"),
      b("new-on-screen", BoolFlag.TRUE),
    ];
    const dirty = new Set([
      "kept-same",
      "flipped",
      "dropped",
      "unshared",
      "new-on-screen",
    ]);

    // Order follows the dirty set's iteration order.
    expect(savedDirtyIds(sent, latest, dirty)).toEqual([
      "kept-same",
      "dropped",
      "unshared",
    ]);
  });

  it.each([
    { label: "both lists empty", sent: [], latest: [] },
    { label: "lists populated", sent: [b("a")], latest: [b("a")] },
  ])("returns [] for an empty dirty set ($label)", ({ sent, latest }) => {
    expect(savedDirtyIds(sent, latest, new Set<string>())).toEqual([]);
  });

  it("compares BoolFlag values strictly (FALSE on screen is not the sent TRUE)", () => {
    // Positive companion for the "differs" row with the opposite direction:
    // an unshare sent, a re-share on screen.
    expect(
      savedDirtyIds(
        [b("a", BoolFlag.FALSE)],
        [b("a", BoolFlag.TRUE)],
        new Set(["a"]),
      ),
    ).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const sent = [b("a", BoolFlag.TRUE), b("b")];
    const latest = [b("a", BoolFlag.FALSE), b("b")];
    const dirty = new Set(["a", "b"]);
    const sentBefore = structuredClone(sent);
    const latestBefore = structuredClone(latest);

    const out = savedDirtyIds(sent, latest, dirty);

    expect(out).toEqual(["b"]);
    expect(sent).toEqual(sentBefore);
    expect(latest).toEqual(latestBefore);
    expect([...dirty]).toEqual(["a", "b"]);
  });
});
