import { describe, it, expect } from "vitest";
import {
  decideLendAction,
  type ReadmooMember,
} from "@/content/readmoo-lend";

const alice: ReadmooMember = { name: "Alice", avatar: "alice.png" };
const bob: ReadmooMember = { name: "Bob", avatar: "bob.png" };
const carol: ReadmooMember = { name: "Carol", avatar: "carol.png" };

describe("decideLendAction", () => {
  it("returns auto-single when there is exactly one member option", () => {
    expect(decideLendAction([alice])).toEqual({
      mode: "auto-single",
      target: alice,
    });
  });

  it("returns auto-single ignoring readmooName when only one option", () => {
    // Even if a stale readmooName disagrees, a single option means we click it.
    expect(decideLendAction([alice], "Bob")).toEqual({
      mode: "auto-single",
      target: alice,
    });
  });

  it("returns auto-match when readmooName matches an option (n >= 2)", () => {
    expect(decideLendAction([alice, bob], "Bob")).toEqual({
      mode: "auto-match",
      target: bob,
    });
  });

  it("trims the stored readmooName before comparing", () => {
    expect(decideLendAction([alice, bob], "  Bob  ")).toEqual({
      mode: "auto-match",
      target: bob,
    });
  });

  it("returns needs-pick when n >= 2 and readmooName is missing", () => {
    expect(decideLendAction([alice, bob])).toEqual({ mode: "needs-pick" });
  });

  it("returns needs-pick when n >= 2 and readmooName is empty string", () => {
    expect(decideLendAction([alice, bob], "")).toEqual({ mode: "needs-pick" });
  });

  it("returns needs-pick when n >= 2 and readmooName is whitespace-only", () => {
    expect(decideLendAction([alice, bob], "   ")).toEqual({
      mode: "needs-pick",
    });
  });

  it("returns needs-pick when readmooName does not match any option", () => {
    expect(decideLendAction([alice, bob, carol], "Dave")).toEqual({
      mode: "needs-pick",
    });
  });

  it("returns needs-pick when there are zero options (defensive)", () => {
    // n=0 is not exactly n>=2 but treat as needs-pick so caller can surface
    // a friendly empty state instead of accidentally clicking nothing.
    expect(decideLendAction([])).toEqual({ mode: "needs-pick" });
  });
});
