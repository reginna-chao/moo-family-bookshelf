import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import {
  computePendingSwitch,
  useEndpointSwitch,
} from "@/dialog/useEndpointSwitch";
import {
  saveDeclinedFamilyEndpoint,
  type DeclinedFamilyEndpoint,
} from "@/storage/familyEndpointChoice";
import { ApiClient, validateEndpointUrl } from "@/api/client";
import {
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
} from "@/constants";

/**
 * `computePendingSwitch` is the pure core of the family-endpoint confirmation
 * gate: given the endpoint the client uses right now, the endpoint the family
 * record asks for, and the previously refused value, it answers "is there a
 * switch the user still has to decide on?".
 *
 * Security contract it encodes (see dialog/useEndpointSwitch.ts): the family
 * record's `apiEndpoint` is owner-controlled and pushed to every member, so it
 * is NEVER adopted implicitly — a non-null return is the only thing that can
 * lead to a switch, and it only happens after the user confirms.
 */

const CURRENT_CUSTOM = "https://current.example";
const FAMILY_CUSTOM = "https://family.example";
/**
 * A family record value whose userinfo LOOKS like the host: the browser would
 * fetch evil.com while the string reads as family.example. The owner controls
 * this field, so it is exactly the shape a malicious owner would plant.
 */
const CREDENTIALS_ENDPOINT = "https://family.example@evil.com";

interface Case {
  name: string;
  current: string;
  familyEndpoint: string | undefined;
  declined: DeclinedFamilyEndpoint | null;
  expected: {
    target: string | null;
    targetEndpoint: string;
    isDefaultTarget: boolean;
    /**
     * Omitted means `true` — the validator accepts the record's value, which is
     * the ordinary case. Only a record the client would REFUSE spells this out,
     * because that is the flag the panel uses to withhold the address.
     */
    targetValid?: boolean;
  } | null;
}

const cases: Case[] = [
  {
    name: "custom → same custom is a no-op",
    current: CURRENT_CUSTOM,
    familyEndpoint: CURRENT_CUSTOM,
    declined: null,
    expected: null,
  },
  {
    name: "custom → different custom asks",
    current: CURRENT_CUSTOM,
    familyEndpoint: FAMILY_CUSTOM,
    declined: null,
    expected: {
      target: FAMILY_CUSTOM,
      targetEndpoint: FAMILY_CUSTOM,
      isDefaultTarget: false,
    },
  },
  {
    name: "default → custom asks",
    current: DEFAULT_API_ENDPOINT,
    familyEndpoint: FAMILY_CUSTOM,
    declined: null,
    expected: {
      target: FAMILY_CUSTOM,
      targetEndpoint: FAMILY_CUSTOM,
      isDefaultTarget: false,
    },
  },
  {
    name: "custom → default (record has no endpoint) asks, flagged as the default target",
    current: CURRENT_CUSTOM,
    familyEndpoint: undefined,
    declined: null,
    expected: {
      target: null,
      targetEndpoint: DEFAULT_API_ENDPOINT,
      isDefaultTarget: true,
    },
  },
  {
    name: "no family endpoint while already on the default is a no-op",
    current: DEFAULT_API_ENDPOINT,
    familyEndpoint: undefined,
    declined: null,
    expected: null,
  },
  {
    // A record that stores the default URL explicitly resolves to the same
    // target as "no endpoint", but is NOT flagged isDefaultTarget — that flag
    // is reserved for the record carrying no endpoint at all.
    name: "record holding the default URL explicitly asks without the default flag",
    current: CURRENT_CUSTOM,
    familyEndpoint: DEFAULT_API_ENDPOINT,
    declined: null,
    expected: {
      target: DEFAULT_API_ENDPOINT,
      targetEndpoint: DEFAULT_API_ENDPOINT,
      isDefaultTarget: false,
    },
  },
  {
    name: "the exact declined custom target is suppressed",
    current: CURRENT_CUSTOM,
    familyEndpoint: FAMILY_CUSTOM,
    declined: { value: FAMILY_CUSTOM },
    expected: null,
  },
  {
    name: "a declined custom target does not suppress a different one",
    current: CURRENT_CUSTOM,
    familyEndpoint: "https://moved.example",
    declined: { value: FAMILY_CUSTOM },
    expected: {
      target: "https://moved.example",
      targetEndpoint: "https://moved.example",
      isDefaultTarget: false,
    },
  },
  {
    name: "a declined revert-to-default (null marker) suppresses the default target",
    current: CURRENT_CUSTOM,
    familyEndpoint: undefined,
    declined: { value: null },
    expected: null,
  },
  {
    name: "a declined revert-to-default does not suppress a custom target",
    current: DEFAULT_API_ENDPOINT,
    familyEndpoint: FAMILY_CUSTOM,
    declined: { value: null },
    expected: {
      target: FAMILY_CUSTOM,
      targetEndpoint: FAMILY_CUSTOM,
      isDefaultTarget: false,
    },
  },
  {
    name: "a declined custom value does not suppress the revert-to-default prompt",
    current: CURRENT_CUSTOM,
    familyEndpoint: undefined,
    declined: { value: CURRENT_CUSTOM },
    expected: {
      target: null,
      targetEndpoint: DEFAULT_API_ENDPOINT,
      isDefaultTarget: true,
    },
  },
  {
    // ApiClient stores what validateEndpointUrl returns (trailing slashes
    // stripped), so the record and the client here are the SAME endpoint spelled
    // two ways — prompting would be pure noise.
    name: "a record value differing only by a trailing slash is a no-op",
    current: FAMILY_CUSTOM,
    familyEndpoint: `${FAMILY_CUSTOM}/`,
    declined: null,
    expected: null,
  },
  {
    name: "surrounding whitespace in the record value is ignored",
    current: FAMILY_CUSTOM,
    familyEndpoint: `  ${FAMILY_CUSTOM}  `,
    declined: null,
    expected: null,
  },
  {
    // The canonical form is what confirm/decline persist, so it must match what
    // the sync-code join path stores for the same endpoint.
    name: "the reported target is canonical, not the record's spelling",
    current: CURRENT_CUSTOM,
    familyEndpoint: `${FAMILY_CUSTOM}//`,
    declined: null,
    expected: {
      target: FAMILY_CUSTOM,
      targetEndpoint: FAMILY_CUSTOM,
      isDefaultTarget: false,
    },
  },
  {
    name: "a decline recorded in canonical form suppresses the trailing-slash spelling of the same target",
    current: CURRENT_CUSTOM,
    familyEndpoint: `${FAMILY_CUSTOM}/`,
    declined: { value: FAMILY_CUSTOM },
    expected: null,
  },
  {
    name: "an empty record value means the official default, never a custom target",
    current: CURRENT_CUSTOM,
    familyEndpoint: "",
    declined: null,
    expected: {
      target: null,
      targetEndpoint: DEFAULT_API_ENDPOINT,
      isDefaultTarget: true,
    },
  },
  {
    name: "a whitespace-only record value means the official default",
    current: CURRENT_CUSTOM,
    familyEndpoint: "   ",
    declined: null,
    expected: {
      target: null,
      targetEndpoint: DEFAULT_API_ENDPOINT,
      isDefaultTarget: true,
    },
  },
  {
    name: "a blank record value asks nothing while already on the default",
    current: DEFAULT_API_ENDPOINT,
    familyEndpoint: "  ",
    declined: null,
    expected: null,
  },
  {
    // A self-hosted record can hold anything. An unusable value is kept verbatim
    // so confirm's try/catch is what refuses it — the user is neither switched
    // silently nor left unasked.
    name: "a value the URL validator refuses (public-host HTTP) is kept verbatim and flagged invalid",
    current: CURRENT_CUSTOM,
    familyEndpoint: "http://evil.example.com",
    declined: null,
    expected: {
      target: "http://evil.example.com",
      targetEndpoint: "http://evil.example.com",
      isDefaultTarget: false,
      targetValid: false,
    },
  },
  {
    name: "an unparseable record value is kept verbatim and flagged invalid",
    current: CURRENT_CUSTOM,
    familyEndpoint: "not-a-url",
    declined: null,
    expected: {
      target: "not-a-url",
      targetEndpoint: "not-a-url",
      isDefaultTarget: false,
      targetValid: false,
    },
  },
  {
    // Same "kept verbatim" rule for a credential-bearing URL, which the
    // validator now refuses. Confirm's try/catch is what stops it being
    // adopted — see "cannot be adopted even if the user confirms" below.
    name: "a credential-bearing record value is kept verbatim and flagged invalid",
    current: CURRENT_CUSTOM,
    familyEndpoint: CREDENTIALS_ENDPOINT,
    declined: null,
    expected: {
      target: CREDENTIALS_ENDPOINT,
      targetEndpoint: CREDENTIALS_ENDPOINT,
      isDefaultTarget: false,
      targetValid: false,
    },
  },
  {
    name: "a non-HTTP scheme in the record is kept verbatim and flagged invalid",
    current: CURRENT_CUSTOM,
    familyEndpoint: "ftp://files.example.com",
    declined: null,
    expected: {
      target: "ftp://files.example.com",
      targetEndpoint: "ftp://files.example.com",
      isDefaultTarget: false,
      targetValid: false,
    },
  },
  {
    // Scheme-less: `new URL()` cannot parse it, so it was never adoptable.
    name: "a bare host in the record is kept verbatim and flagged invalid",
    current: CURRENT_CUSTOM,
    familyEndpoint: "family.example",
    declined: null,
    expected: {
      target: "family.example",
      targetEndpoint: "family.example",
      isDefaultTarget: false,
      targetValid: false,
    },
  },
];

/**
 * `apiEndpoint` is typed `string | undefined`, but it arrives from a KV record
 * that a self-hoster (or an older build) may have written anything into. A
 * non-string must read as "the record carries no endpoint" — i.e. the
 * official-default direction — and never as a target to switch to.
 */
const malformedRecordValues: Array<[string, unknown]> = [
  ["a number", 42],
  ["a boolean", true],
  ["null", null],
  ["an object", { url: FAMILY_CUSTOM }],
  ["an array", [FAMILY_CUSTOM]],
];

describe("computePendingSwitch", () => {
  it.each(cases)("$name", ({ current, familyEndpoint, declined, expected }) => {
    const result = computePendingSwitch({ current, familyEndpoint, declined });

    if (expected === null) {
      expect(result).toBeNull();
      return;
    }
    // `targetValid: true` is the default; a case that expects a refusal
    // overrides it, so an accidental flip in either direction fails here.
    expect(result).toEqual({ current, targetValid: true, ...expected });
  });

  it("always reports the endpoint in effect as `current` so the panel can show both sides", () => {
    const result = computePendingSwitch({
      current: CURRENT_CUSTOM,
      familyEndpoint: FAMILY_CUSTOM,
      declined: null,
    });

    expect(result?.current).toBe(CURRENT_CUSTOM);
    expect(result?.targetEndpoint).toBe(FAMILY_CUSTOM);
  });

  /**
   * `targetValid` exists for one reason: the panel must not print an address
   * `confirm` is guaranteed to refuse as though it were a destination. So the
   * flag has to agree with `validateEndpointUrl` on every value — anchored on
   * production here rather than on a hard-coded expectation.
   */
  describe("targetValid", () => {
    it.each([
      "https://family.example",
      "https://family.example/api",
      "http://localhost:8787",
      "http://192.168.1.50:8787",
      "https://пример.example",
      // Refusals:
      "http://evil.example.com",
      "https://family.example@evil.com",
      "https://user:pass@evil.com",
      "ftp://files.example.com",
      "javascript:alert(1)",
      "not-a-url",
    ])(
      "matches what validateEndpointUrl would do with %s",
      (familyEndpoint) => {
        let accepted = true;
        try {
          validateEndpointUrl(familyEndpoint);
        } catch {
          accepted = false;
        }

        const result = computePendingSwitch({
          current: CURRENT_CUSTOM,
          familyEndpoint,
          declined: null,
        });

        expect(result?.targetValid).toBe(accepted);
      },
    );

    it("keeps a refused address out of nothing but the flag — it is still carried for confirm to reject", () => {
      const result = computePendingSwitch({
        current: CURRENT_CUSTOM,
        familyEndpoint: CREDENTIALS_ENDPOINT,
        declined: null,
      });

      // The hook still needs the raw value: confirm hands it to setEndpoint,
      // whose throw is what produces the refusal notice. Withholding it from
      // the USER is the panel's job (EndpointSwitchPanel.test.tsx).
      expect(result?.targetValid).toBe(false);
      expect(result?.targetEndpoint).toBe(CREDENTIALS_ENDPOINT);
    });
  });

  describe("with a malformed record value", () => {
    it.each(malformedRecordValues)(
      "treats %s as the official-default direction",
      (_label, raw) => {
        const result = computePendingSwitch({
          current: CURRENT_CUSTOM,
          familyEndpoint: raw as string | undefined,
          declined: null,
        });

        expect(result).toEqual({
          current: CURRENT_CUSTOM,
          target: null,
          targetEndpoint: DEFAULT_API_ENDPOINT,
          isDefaultTarget: true,
          // "No endpoint" is a legitimate destination (the official default),
          // so the panel may print it.
          targetValid: true,
        });
      },
    );

    it.each(malformedRecordValues)(
      "asks nothing about %s while the default endpoint is already in effect",
      (_label, raw) => {
        expect(
          computePendingSwitch({
            current: DEFAULT_API_ENDPOINT,
            familyEndpoint: raw as string | undefined,
            declined: null,
          }),
        ).toBeNull();
      },
    );
  });
});

/**
 * The hook wires the pure decision above to the real ApiClient and the real
 * storage helpers. A genuine `ApiClient` is used (not a stub) so `confirm`
 * exercises the production URL validation: an endpoint the client refuses must
 * leave the member on the endpoint they already trust.
 *
 * `tests/setup.ts` backs `browser.storage.local` with an in-memory store, so
 * these tests assert on stored values rather than on call shapes where possible.
 */
describe("useEndpointSwitch", () => {
  /** Plain HTTP on a public host — rejected by ApiClient.setEndpoint. */
  const UNSAFE_ENDPOINT = "http://evil.example.com";

  interface HookProps {
    familyEndpoint: string | undefined;
    membersReady: boolean;
  }

  function renderSwitch(apiClient: ApiClient, initialProps: HookProps) {
    return renderHook(
      ({ familyEndpoint, membersReady }: HookProps) =>
        useEndpointSwitch({ apiClient, familyEndpoint, membersReady }),
      { initialProps },
    );
  }

  async function readStored(key: string): Promise<unknown> {
    const result = (await browser.storage.local.get([key])) as Record<
      string,
      unknown
    >;
    return result[key];
  }

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  it("asks nothing while the members request is still in flight", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result, rerender } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: false,
    });

    await act(async () => {});
    expect(result.current.pending).toBeNull();

    rerender({ familyEndpoint: FAMILY_CUSTOM, membersReady: true });

    await waitFor(() => {
      expect(result.current.pending?.targetEndpoint).toBe(FAMILY_CUSTOM);
    });
  });

  it("never flashes a panel for a target the user already declined", async () => {
    await saveDeclinedFamilyEndpoint({ value: FAMILY_CUSTOM });
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);

    const { result } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    expect(result.current.pending).toBeNull();
    await act(async () => {});
    expect(result.current.pending).toBeNull();
  });

  it("asks once the stored decision is read and it covers a different endpoint", async () => {
    await saveDeclinedFamilyEndpoint({ value: "https://declined.example" });
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);

    const { result } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    await waitFor(() => {
      expect(result.current.pending).toEqual({
        current: DEFAULT_API_ENDPOINT,
        target: FAMILY_CUSTOM,
        targetEndpoint: FAMILY_CUSTOM,
        isDefaultTarget: false,
        targetValid: true,
      });
    });
  });

  it("confirm switches the client, stores the endpoint, and notifies the background", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());

    act(() => result.current.confirm());

    expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
    expect(result.current.pending).toBeNull();
    await waitFor(async () => {
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
    });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: FAMILY_CUSTOM,
    });
  });

  it("confirm on a revert-to-default REMOVES the stored endpoint", async () => {
    await browser.storage.local.set({ [API_ENDPOINT_KEY]: CURRENT_CUSTOM });
    const apiClient = new ApiClient(CURRENT_CUSTOM);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: undefined,
      membersReady: true,
    });

    await waitFor(() =>
      expect(result.current.pending?.isDefaultTarget).toBe(true),
    );

    act(() => result.current.confirm());

    expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
    await waitFor(async () => {
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();
    });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: null,
    });
  });

  it("confirm clears a stale declined marker for the accepted endpoint", async () => {
    await saveDeclinedFamilyEndpoint({ value: "https://declined.example" });
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());

    act(() => result.current.confirm());

    await waitFor(async () => {
      await expect(
        readStored(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
    });
  });

  it("decline keeps the current endpoint and records the refusal", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());

    act(() => result.current.decline());

    expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
    expect(result.current.pending).toBeNull();
    await waitFor(async () => {
      await expect(readStored(DECLINED_FAMILY_ENDPOINT_KEY)).resolves.toEqual({
        value: FAMILY_CUSTOM,
      });
    });
    await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();
  });

  it("does not re-ask for the declined endpoint, but does ask when it changes", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result, rerender } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => result.current.decline());

    // Same record value on a later members refresh — stays silent.
    rerender({ familyEndpoint: FAMILY_CUSTOM, membersReady: true });
    await act(async () => {});
    expect(result.current.pending).toBeNull();

    // The owner moves the family to another endpoint — ask again.
    rerender({ familyEndpoint: "https://moved.example", membersReady: true });
    await waitFor(() => {
      expect(result.current.pending?.targetEndpoint).toBe(
        "https://moved.example",
      );
    });
  });

  it("asks nothing when the record's endpoint is blank and the default is in effect", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: "   ",
      membersReady: true,
    });

    await act(async () => {});

    expect(result.current.pending).toBeNull();
    expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
  });

  it("confirm persists the CANONICAL endpoint, not the record's spelling", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: `${FAMILY_CUSTOM}/`,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.targetEndpoint).toBe(FAMILY_CUSTOM);

    act(() => result.current.confirm());

    // Everything the switch leaves behind is in the same form the sync-code
    // join path stores for this endpoint, so the two cannot disagree later.
    expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
    await waitFor(async () => {
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
    });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: FAMILY_CUSTOM,
    });
  });

  it("decline remembers the CANONICAL value, so the same endpoint stops re-prompting however it is spelled", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result, rerender } = renderSwitch(apiClient, {
      familyEndpoint: `${FAMILY_CUSTOM}/`,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());

    act(() => result.current.decline());

    await waitFor(async () => {
      await expect(readStored(DECLINED_FAMILY_ENDPOINT_KEY)).resolves.toEqual({
        value: FAMILY_CUSTOM,
      });
    });

    // Same endpoint, slash-free spelling on a later members refresh: silent.
    rerender({ familyEndpoint: FAMILY_CUSTOM, membersReady: true });
    await act(async () => {});
    expect(result.current.pending).toBeNull();
  });

  it("keeps the current endpoint and files the value as declined when the client rejects it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result, rerender } = renderSwitch(apiClient, {
      familyEndpoint: UNSAFE_ENDPOINT,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    // Flagged before the user acts, so the panel can withhold the address
    // rather than presenting a doomed switch as a real destination.
    expect(result.current.pending?.targetValid).toBe(false);

    act(() => result.current.confirm());

    expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
    expect(result.current.pending).toBeNull();
    expect(result.current.confirmError).toBe(true);
    expect(warn).toHaveBeenCalled();
    await waitFor(async () => {
      await expect(readStored(DECLINED_FAMILY_ENDPOINT_KEY)).resolves.toEqual({
        value: UNSAFE_ENDPOINT,
      });
    });
    await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();

    // An unusable record must not re-open the panel on every members refresh.
    rerender({ familyEndpoint: UNSAFE_ENDPOINT, membersReady: true });
    await act(async () => {});
    expect(result.current.pending).toBeNull();

    warn.mockRestore();
  });

  /**
   * A family record's `apiEndpoint` is owner-controlled, so a userinfo
   * masquerade (`https://family.example@evil.com` — fetches evil.com) is the
   * natural attack here. `validateEndpointUrl` now refuses credentials, so the
   * switch must fail closed even when the user presses 確認切換.
   */
  it("a credential-bearing family endpoint cannot be adopted even if the user confirms", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const apiClient = new ApiClient(CURRENT_CUSTOM);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: CREDENTIALS_ENDPOINT,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.targetValid).toBe(false);

    act(() => result.current.confirm());

    // Nothing switched: neither the client, nor the persisted endpoint, nor the
    // value the sync code is built from.
    expect(apiClient.getEndpoint()).toBe(CURRENT_CUSTOM);
    expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
    expect(result.current.confirmError).toBe(true);
    await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();
    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_API_ENDPOINT" }),
    );

    warn.mockRestore();
  });

  it("confirm and decline are no-ops when nothing is pending", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: DEFAULT_API_ENDPOINT,
      membersReady: true,
    });

    await act(async () => {});
    expect(result.current.pending).toBeNull();

    act(() => {
      result.current.confirm();
      result.current.decline();
    });

    await act(async () => {});
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(browser.storage.local.remove).not.toHaveBeenCalled();
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  /**
   * `adoptedEndpoint` is the endpoint THIS device actually uses, surfaced as
   * React state because `apiClient.setEndpoint()` mutates without re-rendering.
   * The sync code / invite / QR are built from it, never from the family
   * record's value — otherwise a member who DECLINED a switch would hand out an
   * invite pointing at the endpoint they just refused, and a member who
   * CONFIRMED one would keep handing out the stale endpoint until the dialog was
   * reopened.
   */
  describe("adoptedEndpoint", () => {
    it("seeds from the client, not from the family record", async () => {
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });

      // The record advertises a different endpoint, but nothing is adopted
      // until the user says so.
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
    });

    it("reports the official default when the client is on it", async () => {
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: undefined,
        membersReady: true,
      });

      await act(async () => {});
      expect(result.current.adoptedEndpoint).toBe(DEFAULT_API_ENDPOINT);
    });

    it("advances to the target the moment confirm succeeds", async () => {
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.adoptedEndpoint).toBe(DEFAULT_API_ENDPOINT);

      act(() => result.current.confirm());

      // In step with the client, with no reopen/remount in between.
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);
      expect(result.current.adoptedEndpoint).toBe(apiClient.getEndpoint());
    });

    it("advances to the CANONICAL target, matching what the client stores", async () => {
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: `${FAMILY_CUSTOM}/`,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.confirm());

      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);
      expect(result.current.adoptedEndpoint).toBe(apiClient.getEndpoint());
    });

    it("falls back to the official default when confirming a revert", async () => {
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: undefined,
        membersReady: true,
      });

      await waitFor(() =>
        expect(result.current.pending?.isDefaultTarget).toBe(true),
      );
      act(() => result.current.confirm());

      expect(result.current.adoptedEndpoint).toBe(DEFAULT_API_ENDPOINT);
      expect(result.current.adoptedEndpoint).toBe(apiClient.getEndpoint());
    });

    it("stays put when the user declines a custom endpoint", async () => {
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.decline());

      // A refused endpoint must never reach the sync code the member shares.
      expect(result.current.adoptedEndpoint).toBe(DEFAULT_API_ENDPOINT);
      expect(result.current.adoptedEndpoint).toBe(apiClient.getEndpoint());
    });

    it("keeps the custom endpoint when the user declines a revert to default", async () => {
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: undefined,
        membersReady: true,
      });

      await waitFor(() =>
        expect(result.current.pending?.isDefaultTarget).toBe(true),
      );
      act(() => result.current.decline());

      // Declining a revert keeps this device on its custom endpoint, so the
      // sync code must keep carrying that @host.
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
      expect(result.current.adoptedEndpoint).toBe(apiClient.getEndpoint());
    });

    it("stays put when confirm is refused by the client's URL validation", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: UNSAFE_ENDPOINT,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.confirm());

      expect(result.current.confirmError).toBe(true);
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
      expect(result.current.adoptedEndpoint).toBe(apiClient.getEndpoint());

      warn.mockRestore();
    });

    it("is unaffected by later members refreshes that ask nothing", async () => {
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result, rerender } = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.confirm());
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);

      rerender({ familyEndpoint: FAMILY_CUSTOM, membersReady: true });
      await act(async () => {});

      expect(result.current.pending).toBeNull();
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);
    });
  });

  /**
   * A confirmation the client's own URL validation then refuses must be told to
   * the user: the panel closing on its own reads as "switched successfully",
   * while the member is in fact still on the old endpoint.
   */
  describe("confirmError", () => {
    /** Confirm an unusable target and settle the storage write it triggers. */
    async function failedConfirm() {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result, rerender } = renderSwitch(apiClient, {
        familyEndpoint: UNSAFE_ENDPOINT,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.confirmError).toBe(false);

      act(() => result.current.confirm());
      await act(async () => {});

      return { apiClient, result, rerender, warn };
    }

    it("stays clear while an ordinary question is pending and after it is answered", async () => {
      const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });

      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.confirmError).toBe(false);

      act(() => result.current.confirm());
      await act(async () => {});

      expect(result.current.confirmError).toBe(false);
    });

    it("survives the recompute that filing the refused value as declined triggers", async () => {
      const { result, rerender, warn } = await failedConfirm();

      // The failed confirm records a decline, which re-runs the recompute effect
      // with nothing pending — the notice must outlive that, and every later
      // members refresh, until the user acknowledges it.
      expect(result.current.confirmError).toBe(true);
      expect(result.current.pending).toBeNull();

      rerender({ familyEndpoint: UNSAFE_ENDPOINT, membersReady: true });
      await act(async () => {});

      expect(result.current.confirmError).toBe(true);
      expect(result.current.pending).toBeNull();

      warn.mockRestore();
    });

    it("is cleared by dismissConfirmError without re-opening the question", async () => {
      const { result, rerender, warn } = await failedConfirm();

      act(() => result.current.dismissConfirmError());

      expect(result.current.confirmError).toBe(false);
      expect(result.current.pending).toBeNull();

      // Acknowledging is not a retry: the refused value stays declined.
      rerender({ familyEndpoint: UNSAFE_ENDPOINT, membersReady: true });
      await act(async () => {});
      expect(result.current.pending).toBeNull();
      expect(result.current.confirmError).toBe(false);

      warn.mockRestore();
    });

    it("is cleared by a fresh question, which supersedes the stale notice", async () => {
      const { result, rerender, warn } = await failedConfirm();
      expect(result.current.confirmError).toBe(true);

      // The owner moves the family to a usable endpoint.
      rerender({ familyEndpoint: FAMILY_CUSTOM, membersReady: true });

      await waitFor(() => {
        expect(result.current.pending?.targetEndpoint).toBe(FAMILY_CUSTOM);
      });
      expect(result.current.confirmError).toBe(false);

      warn.mockRestore();
    });
  });
});
