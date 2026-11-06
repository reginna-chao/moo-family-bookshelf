import {
  createElement,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { View } from "@/dialog/App";
import { unmountFamilyTreeThenResetClient } from "@/dialog/familyTreeTeardown";
import { DEFAULT_API_ENDPOINT } from "@/constants";

/**
 * `unmountFamilyTreeThenResetClient` (#454): the unit half of the ordering pinned end to end in
 * tests/component/AppFamilyTeardownEndpoint.test.tsx. These cases cover what that journey cannot
 * reach: the non-`main` views, and an update that throws.
 *
 * Uses a real React tree rather than a recorded `setView` where the claim is about the commit: a
 * mocked setter would pass even if nothing had unmounted when the client was reset.
 */

/** Client double whose calls land in `log`, interleaved with the view tree's cleanups. */
function recordingClient(log: string[] = []) {
  return {
    setAuthToken: vi.fn((token: string | null) => {
      log.push(`setAuthToken:${String(token)}`);
    }),
    setEndpoint: vi.fn((url: string) => {
      log.push(`setEndpoint:${url}`);
    }),
  };
}

const CLIENT_RESET_LOG = [
  "setAuthToken:null",
  `setEndpoint:${DEFAULT_API_ENDPOINT}`,
];

interface Harness {
  setView: Dispatch<SetStateAction<View>>;
  mounts: () => number;
  log: string[];
}

/** One keyed child per view, so a view change is a real unmount + mount of that child. */
function renderViewTree(initial: View): Harness {
  const log: string[] = [];
  let setViewRef: Dispatch<SetStateAction<View>> = () => {};
  let mounts = 0;

  const ViewBody = ({ view }: { view: View }) => {
    useEffect(() => {
      mounts += 1;
      return () => {
        log.push(`cleanup:${view}`);
      };
    }, [view]);
    return createElement("div", { "data-testid": "view" }, view);
  };
  const Tree = () => {
    const [view, setView] = useState<View>(initial);
    setViewRef = setView;
    return createElement(ViewBody, { key: view, view });
  };

  render(createElement(Tree));
  return { setView: (action) => setViewRef(action), mounts: () => mounts, log };
}

describe("unmountFamilyTreeThenResetClient", () => {
  it("moves the main view to loading, unmounting what it held", () => {
    const { setView, mounts, log } = renderViewTree("main");

    act(() => unmountFamilyTreeThenResetClient(recordingClient(), setView));

    expect(screen.getByTestId("view")).toHaveTextContent("loading");
    expect(log).toEqual(["cleanup:main"]);
    expect(mounts()).toBe(2);
  });

  it("moves the onboarding view to loading, unmounting what it held, and still resets the client", () => {
    const { setView, mounts, log } = renderViewTree("onboarding");
    const clientLog: string[] = [];

    act(() =>
      unmountFamilyTreeThenResetClient(recordingClient(clientLog), setView),
    );

    expect(screen.getByTestId("view")).toHaveTextContent("loading");
    expect(log).toEqual(["cleanup:onboarding"]);
    expect(mounts()).toBe(2);
    expect(clientLog).toEqual(CLIENT_RESET_LOG);
  });

  it.each<View>(["loading", "account-mismatch"])(
    "leaves the %s view mounted and still resets the client",
    (view) => {
      const { setView, mounts, log } = renderViewTree(view);
      const clientLog: string[] = [];

      act(() =>
        unmountFamilyTreeThenResetClient(recordingClient(clientLog), setView),
      );

      expect(screen.getByTestId("view")).toHaveTextContent(view);
      expect(log).toEqual([]);
      expect(mounts()).toBe(1);
      expect(clientLog).toEqual(CLIENT_RESET_LOG);
    },
  );

  // Asserted inside `act`: only flushSync can have run the cleanup before act's own flush.
  it("resets the token, then the endpoint, only after the unmount cleanups have run", () => {
    const { setView, log } = renderViewTree("main");

    act(() => {
      unmountFamilyTreeThenResetClient(recordingClient(log), setView);
      expect(log).toEqual(["cleanup:main", ...CLIENT_RESET_LOG]);
    });
  });

  it("still resets the token and the endpoint when the update throws", () => {
    const boom = new Error("update failed");
    const setView = vi.fn(() => {
      throw boom;
    });
    const clientLog: string[] = [];

    expect(() =>
      unmountFamilyTreeThenResetClient(recordingClient(clientLog), setView),
    ).toThrow(boom);

    expect(clientLog).toEqual(CLIENT_RESET_LOG);
  });
});
