import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import {
  computePendingSwitch,
  useEndpointSwitch,
} from "@/dialog/useEndpointSwitch";
import {
  FAMILY_ENDPOINT_CHOICE_KEYS,
  saveDeclinedFamilyEndpoint,
  type DeclinedFamilyEndpoint,
} from "@/storage/familyEndpointChoice";
import { clearStoredFamilyBinding } from "@/dialog/familyBindingReset";
import { ApiClient, validateEndpointUrl } from "@/api/client";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  TOKEN_EXPIRES_AT_KEY,
  TOKEN_SERVER_KEY,
  USER_ID_KEY,
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
 *
 * Case-table notes:
 *  - `CREDENTIALS_ENDPOINT` is a family record value whose userinfo LOOKS like
 *    the host: the browser would fetch evil.com while the string reads as
 *    family.example. The owner controls this field, so it is exactly the shape a
 *    malicious owner would plant (the natural attack here). `validateEndpointUrl`
 *    now refuses credentials, so the switch must fail closed even when the user
 *    presses 確認切換.
 *  - `targetValid` omitted means `true` — the validator accepts the record's
 *    value, the ordinary case. Only a record the client would REFUSE spells it
 *    out, because that is the flag the panel uses to withhold the address.
 *  - A record that stores the default URL explicitly resolves to the same target
 *    as "no endpoint", but is NOT flagged isDefaultTarget — that flag is reserved
 *    for the record carrying no endpoint at all.
 *  - ApiClient stores what validateEndpointUrl returns (trailing slashes
 *    stripped), so a record differing only by a trailing slash is the SAME
 *    endpoint spelled two ways — prompting would be pure noise.
 *  - A self-hosted record can hold anything. An unusable value (public-host HTTP,
 *    a credential-bearing URL) is kept verbatim so confirm's try/catch is what
 *    refuses it — the user is neither switched silently nor left unasked.
 *  - Malformed record values: `apiEndpoint` is typed `string | undefined`, but it
 *    arrives from a KV record that a self-hoster (or an older build) may have
 *    written anything into. A non-string must read as "the record carries no
 *    endpoint" — i.e. the official-default direction — and never as a target to
 *    switch to.
 *  - `targetValid` exists for one reason: the panel must not print an address
 *    `confirm` is guaranteed to refuse as though it were a destination. So the
 *    flag has to agree with `validateEndpointUrl` on every value — anchored on
 *    production rather than on a hard-coded expectation. The hook still needs the
 *    raw value: confirm hands it to setEndpoint, whose throw is what produces the
 *    refusal notice; withholding it from the USER is the panel's job
 *    (EndpointSwitchPanel.test.tsx).
 *
 * useEndpointSwitch wires the pure decision to the real ApiClient and the real
 * storage helpers. A genuine `ApiClient` is used (not a stub) so `confirm`
 * exercises the production URL validation: an endpoint the client refuses must
 * leave the member on the endpoint they already trust. `tests/setup.ts` backs
 * `browser.storage.local` with an in-memory store, so these tests assert on
 * stored values rather than on call shapes where possible.
 *  - A confirmed switch and the old token (#456): `confirm` checks the stored family
 *    binding first (one storage read, nothing written), then moves the client and
 *    drops the in-memory token with no await before the storage writes, so a refresh
 *    in flight is already discarded by the time storage is written, and nothing a
 *    late response does can reach storage. Because of that first read, every case
 *    confirms inside an async `act`, which settles the whole chain, and beforeEach
 *    stores the family the hook is bound to. The storage half may fail: then the client
 *    stays on the new server with no token (a 401 there refuses to refresh, because
 *    storage still pairs the token with the old server), `confirmSaveFailed` tells
 *    the user, and `adoptedEndpoint` goes back to what storage says. The rejoin that
 *    follows a confirm is pinned in tests/unit/api/tokenBinding.test.ts.
 *  - `adoptedEndpoint` is the endpoint THIS device actually uses, surfaced as
 *    React state because `apiClient.setEndpoint()` mutates without re-rendering.
 *    The sync code / invite / QR are built from it, never from the family
 *    record's value — otherwise a member who DECLINED a switch would hand out an
 *    invite pointing at the endpoint they just refused, and a member who
 *    CONFIRMED one would keep handing out the stale endpoint until the dialog
 *    was reopened.
 *  - `confirmError`: a confirmation the client's own URL validation then refuses
 *    must be told to the user — the panel closing on its own reads as "switched
 *    successfully", while the member is in fact still on the old endpoint. The
 *    failed confirm records a decline, which re-runs the recompute effect with
 *    nothing pending; the notice must outlive that, and every later members
 *    refresh, until the user acknowledges it.
 *  - The stored family binding (#498): another tab may have left the family (or
 *    left it and joined another) while this screen still shows it. A confirm
 *    refused BEFORE the write (another family, none, or an unreadable store)
 *    leaves the client, its in-memory token and storage alone and records no
 *    decline — on a family-less device a decline would mute the next family's
 *    question — and `confirmBindingGone` tells the user. A binding found gone
 *    AFTER the write keeps the client where the confirm put it (a teardown may
 *    already have moved it) and rolls `adoptedEndpoint` back. While a confirm is
 *    in flight, a second confirm and a decline do nothing; an unmount before the
 *    first read returns ends it with nothing done. The other tab's writes go
 *    through the store's own writers (unrecorded), keyed on the read's key list.
 *    The store-level outcomes are pinned in tests/unit/storage/familyEndpointChoice.test.ts.
 */

const CURRENT_CUSTOM = "https://current.example";
const FAMILY_CUSTOM = "https://family.example";
/** Userinfo that LOOKS like the host (fetches evil.com) — what a malicious owner
 *  would plant. See the header → "Case-table notes". */
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
    /** Omitted means `true`; only a record the client would REFUSE spells it out
     *  (the panel withholds the address on it). */
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
    // Same target as "no endpoint", but NOT isDefaultTarget — reserved for a
    // record carrying no endpoint at all.
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
    // Trailing slashes are stripped by the validator: the SAME endpoint spelled
    // two ways, so prompting would be noise.
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
    // An unusable value is kept verbatim so confirm's try/catch refuses it — never
    // a silent switch, never left unasked.
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
    // Same "kept verbatim" rule for a credential-bearing URL; see "cannot be
    // adopted even if the user confirms" below.
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

/** Non-string KV values must read as "no endpoint" (official default), never as a
 *  switch target. See the header → "Case-table notes". */
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

  // `targetValid` must agree with `validateEndpointUrl` on every value (anchored on
  // production). See the header → "Case-table notes".
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

      // The hook keeps the raw value for confirm; hiding it from the USER is the
      // panel's job (EndpointSwitchPanel.test.tsx).
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

// A genuine ApiClient (production validation) over the in-memory storage mock.
// See the header → "useEndpointSwitch".
describe("useEndpointSwitch", () => {
  /** Plain HTTP on a public host — rejected by ApiClient.setEndpoint. */
  const UNSAFE_ENDPOINT = "http://evil.example.com";
  /** The shared store's own writers, which a case wraps to land an interleaving inside a write. */
  const realStoreSet = vi
    .mocked(browser.storage.local.set)
    .getMockImplementation()!;
  const realStoreRemove = vi
    .mocked(browser.storage.local.remove)
    .getMockImplementation()!;

  /** The family every rendered hook is bound to; beforeEach stores it. */
  const FAMILY_ID = "fam-1";

  interface HookProps {
    familyEndpoint: string | undefined;
    membersReady: boolean;
  }

  function renderSwitch(apiClient: ApiClient, initialProps: HookProps) {
    return renderHook(
      ({ familyEndpoint, membersReady }: HookProps) =>
        useEndpointSwitch({
          apiClient,
          familyId: FAMILY_ID,
          familyEndpoint,
          membersReady,
        }),
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
    // A confirm goes through only while storage binds the hook's family (#498).
    await browser.storage.local.set({ [FAMILY_ID_KEY]: FAMILY_ID });
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

  it("confirm switches the client and stores the endpoint", async () => {
    const apiClient = new ApiClient(DEFAULT_API_ENDPOINT);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: FAMILY_CUSTOM,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());

    await act(async () => result.current.confirm());

    expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
    expect(result.current.pending).toBeNull();
    await waitFor(async () => {
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
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

    await act(async () => result.current.confirm());

    expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
    await waitFor(async () => {
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();
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

    await act(async () => result.current.confirm());

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

    await act(async () => result.current.confirm());

    // Everything the switch leaves behind is in the same form the sync-code
    // join path stores for this endpoint, so the two cannot disagree later.
    expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
    await waitFor(async () => {
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
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

    await act(async () => result.current.confirm());

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

  // A userinfo masquerade must fail closed even after 確認切換.
  // See the header → "Case-table notes".
  it("a credential-bearing family endpoint cannot be adopted even if the user confirms", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const apiClient = new ApiClient(CURRENT_CUSTOM);
    const { result } = renderSwitch(apiClient, {
      familyEndpoint: CREDENTIALS_ENDPOINT,
      membersReady: true,
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.targetValid).toBe(false);

    await act(async () => result.current.confirm());

    // Nothing switched: neither the client, nor the persisted endpoint, nor the
    // value the sync code is built from.
    expect(apiClient.getEndpoint()).toBe(CURRENT_CUSTOM);
    expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
    expect(result.current.confirmError).toBe(true);
    await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();

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

  // The endpoint THIS device uses; sync code / invite / QR come from it, never the
  // record. See the header → "useEndpointSwitch".
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

      await act(async () => result.current.confirm());

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
      await act(async () => result.current.confirm());

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
      await act(async () => result.current.confirm());

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
      await act(async () => result.current.confirm());

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
      await act(async () => result.current.confirm());
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);

      rerender({ familyEndpoint: FAMILY_CUSTOM, membersReady: true });
      await act(async () => {});

      expect(result.current.pending).toBeNull();
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);
    });
  });

  // See the header → "A confirmed switch and the old token".
  describe("a confirmed switch and the old token", () => {
    const OLD_TOKEN = "a".repeat(64);
    const HOSTILE_TOKEN = "c".repeat(64);
    const USER_ID = "1".repeat(64);
    const originalFetch = globalThis.fetch;

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    async function seedOldSession(): Promise<void> {
      await browser.storage.local.set({
        [USER_ID_KEY]: USER_ID,
        [FAMILY_ID_KEY]: FAMILY_ID,
        [API_ENDPOINT_KEY]: CURRENT_CUSTOM,
        [AUTH_TOKEN_KEY]: OLD_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 123,
        [TOKEN_SERVER_KEY]: CURRENT_CUSTOM,
      });
      vi.clearAllMocks();
    }

    async function askedSwitch() {
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      apiClient.setAuthToken(OLD_TOKEN);
      const hook = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });
      await waitFor(() => expect(hook.result.current.pending).not.toBeNull());
      return { apiClient, ...hook };
    }

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.mocked(browser.storage.local.set).mockImplementation(realStoreSet);
      vi.mocked(browser.storage.local.remove).mockImplementation(
        realStoreRemove,
      );
    });

    it("moves the client, drops the token and closes the panel before any storage write lands", async () => {
      await seedOldSession();
      const { apiClient, result } = await askedSwitch();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { books: [] } }),
      });
      globalThis.fetch = fetchMock;
      const firstRemoval = deferred<void>();
      vi.mocked(browser.storage.local.remove).mockImplementationOnce(
        () => firstRemoval.promise,
      );

      await act(async () => result.current.confirm());

      expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
      expect(result.current.pending).toBeNull();
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);
      expect(browser.storage.local.set).not.toHaveBeenCalled();
      await apiClient.getPersonalBooks(USER_ID);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url.startsWith(FAMILY_CUSTOM)).toBe(true);
      expect(
        (init.headers as Record<string, string>).Authorization,
      ).toBeUndefined();

      // Dropped, not just withheld: a move back to its issuer finds no token either.
      apiClient.setEndpoint(CURRENT_CUSTOM);
      await apiClient.getPersonalBooks(USER_ID);
      const [, initAfterReturn] = fetchMock.mock.calls[1] as [
        string,
        RequestInit,
      ];
      expect(
        (initAfterReturn.headers as Record<string, string>).Authorization,
      ).toBeUndefined();

      await act(async () => {
        firstRemoval.resolve();
        await firstRemoval.promise;
      });
    });

    it("leaves storage with the new endpoint and no old token", async () => {
      await seedOldSession();
      const { result } = await askedSwitch();

      await act(async () => result.current.confirm());
      await act(async () => {});

      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readStored(TOKEN_EXPIRES_AT_KEY)).resolves.toBeUndefined();
      await expect(readStored(TOKEN_SERVER_KEY)).resolves.toBeUndefined();
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
      expect(result.current.confirmSaveFailed).toBe(false);
    });

    it("drops a refresh token that lands while the storage write is running", async () => {
      await seedOldSession();
      const { apiClient, result } = await askedSwitch();
      const refresh = deferred<unknown>();
      globalThis.fetch = vi.fn((input: unknown) =>
        String(input).endsWith("/api/auth/refresh")
          ? refresh.promise
          : Promise.resolve({
              ok: false,
              status: 401,
              json: () =>
                Promise.resolve({
                  error: { code: "UNAUTHORIZED", message: "x" },
                }),
            }),
      ) as unknown as typeof fetch;

      const pendingRequest = apiClient.getPersonalBooks(USER_ID);
      await waitFor(() =>
        expect(globalThis.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/auth/refresh"),
          expect.anything(),
        ),
      );

      // The refresh answers during the first removal: before the endpoint write.
      const storeRemove = realStoreRemove;
      vi.mocked(browser.storage.local.remove).mockImplementationOnce(
        async (keys) => {
          await storeRemove(keys);
          refresh.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: { token: HOSTILE_TOKEN, expiresAt: 9_999_999_999_999 },
              }),
          });
          await pendingRequest;
        },
      );

      await act(async () => result.current.confirm());
      await act(async () => {
        await pendingRequest;
      });
      await act(async () => {});

      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
    });

    it("clears a token another tab wrote back during the endpoint write", async () => {
      await seedOldSession();
      const { result } = await askedSwitch();
      vi.mocked(browser.storage.local.set).mockImplementationOnce(
        async (items) => {
          await realStoreSet({ [AUTH_TOKEN_KEY]: OLD_TOKEN });
          await realStoreSet(items);
        },
      );

      await act(async () => result.current.confirm());
      await act(async () => {});

      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
    });

    const SAVE_FAILURES = [
      {
        name: "the token removal fails",
        arm: () =>
          vi
            .mocked(browser.storage.local.remove)
            .mockRejectedValueOnce(new Error("storage unavailable")),
        storedAfter: OLD_TOKEN,
      },
      {
        name: "the endpoint write fails",
        arm: () =>
          vi
            .mocked(browser.storage.local.set)
            .mockRejectedValueOnce(new Error("storage unavailable")),
        storedAfter: undefined,
      },
    ];

    it.each(SAVE_FAILURES)(
      "reports the failure and sends no message when $name",
      async ({ arm, storedAfter }) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await seedOldSession();
        const { apiClient, result } = await askedSwitch();
        arm();

        await act(async () => result.current.confirm());
        await act(async () => {});

        expect(result.current.confirmSaveFailed).toBe(true);
        expect(result.current.confirmError).toBe(false);
        expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
        await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(
          CURRENT_CUSTOM,
        );
        await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBe(storedAfter);
        // The client stays where the confirm put it, holding no token.
        expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);

        warn.mockRestore();
      },
    );

    it("sends the new server nothing of the old session on a 401 after a failed save", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await seedOldSession();
      const { apiClient, result } = await askedSwitch();
      vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
      await act(async () => result.current.confirm());
      await act(async () => {});
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({ error: { code: "UNAUTHORIZED", message: "x" } }),
      });
      globalThis.fetch = fetchMock;

      const response = await apiClient.getPersonalBooks(USER_ID);

      expect(response.error?.code).toBe("UNAUTHORIZED");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url.startsWith(FAMILY_CUSTOM)).toBe(true);
      expect(
        (init.headers as Record<string, string>).Authorization,
      ).toBeUndefined();
      warn.mockRestore();
    });

    it("clears confirmSaveFailed through dismissConfirmError", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await seedOldSession();
      const { result } = await askedSwitch();
      vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
      await act(async () => result.current.confirm());
      await act(async () => {});
      expect(result.current.confirmSaveFailed).toBe(true);

      act(() => result.current.dismissConfirmError());

      expect(result.current.confirmSaveFailed).toBe(false);
      warn.mockRestore();
    });

    it("clears confirmSaveFailed when a fresh question appears", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await seedOldSession();
      const { result, rerender } = await askedSwitch();
      vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
      await act(async () => result.current.confirm());
      await act(async () => {});
      expect(result.current.confirmSaveFailed).toBe(true);

      rerender({
        familyEndpoint: "https://moved.example",
        membersReady: true,
      });

      await waitFor(() =>
        expect(result.current.pending?.targetEndpoint).toBe(
          "https://moved.example",
        ),
      );
      expect(result.current.confirmSaveFailed).toBe(false);
      warn.mockRestore();
    });

    it("does not raise confirmSaveFailed when the client refuses the value", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await seedOldSession();
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      apiClient.setAuthToken(OLD_TOKEN);
      const { result } = renderSwitch(apiClient, {
        familyEndpoint: UNSAFE_ENDPOINT,
        membersReady: true,
      });
      await waitFor(() => expect(result.current.pending).not.toBeNull());

      await act(async () => result.current.confirm());
      await act(async () => {});

      expect(result.current.confirmError).toBe(true);
      expect(result.current.confirmSaveFailed).toBe(false);
      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBe(OLD_TOKEN);
      warn.mockRestore();
    });
  });

  // A refused confirmation must be told to the user, or the closing panel reads as
  // "switched successfully".
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

      await act(async () => result.current.confirm());
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

      await act(async () => result.current.confirm());
      await act(async () => {});

      expect(result.current.confirmError).toBe(false);
    });

    it("survives the recompute that filing the refused value as declined triggers", async () => {
      const { result, rerender, warn } = await failedConfirm();

      // The notice must outlive the decline-triggered recompute and every later
      // members refresh, until acknowledged.
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

  // See the header → "The stored family binding".
  describe("the stored family binding", () => {
    const OLD_TOKEN = "a".repeat(64);
    const OTHER_TOKEN = "b".repeat(64);
    const OTHER_FAMILY = "fam-2";
    const OTHER_ENDPOINT = "https://other-family.example";
    const PRE_READ_KEYS = [FAMILY_ID_KEY];
    const RE_READ_KEYS = [FAMILY_ID_KEY, API_ENDPOINT_KEY, AUTH_TOKEN_KEY];
    const UNDO_KEYS = [
      ...FAMILY_ENDPOINT_CHOICE_KEYS,
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
      TOKEN_SERVER_KEY,
    ];
    const realStoreGet = vi
      .mocked(browser.storage.local.get)
      .getMockImplementation()!;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
      vi.mocked(browser.storage.local.get).mockImplementation(realStoreGet);
      vi.mocked(browser.storage.local.set).mockImplementation(realStoreSet);
      vi.mocked(browser.storage.local.remove).mockImplementation(
        realStoreRemove,
      );
    });

    function sameKeys(keys: unknown, expected: string[]): boolean {
      return (
        Array.isArray(keys) &&
        keys.length === expected.length &&
        expected.every((key) => keys.includes(key))
      );
    }

    function readsWith(expected: string[]): number {
      return vi
        .mocked(browser.storage.local.get)
        .mock.calls.filter(([keys]) => sameKeys(keys, expected)).length;
    }

    function setsWith(key: string): number {
      return vi
        .mocked(browser.storage.local.set)
        .mock.calls.filter(([items]) => key in (items as object)).length;
    }

    function removalsWith(key: string): unknown[] {
      return vi
        .mocked(browser.storage.local.remove)
        .mock.calls.map(([keys]) => keys)
        .filter((keys) => Array.isArray(keys) && keys.includes(key));
    }

    /** Runs `write` on the real store right before the read asking for `readKeys`. */
    function landBefore(
      readKeys: string[],
      write: () => Promise<unknown>,
    ): void {
      vi.mocked(browser.storage.local.get).mockImplementation(async (keys) => {
        if (sameKeys(keys, readKeys)) await write();
        return realStoreGet(keys);
      });
    }

    async function seedSession({
      familyId = FAMILY_ID,
      endpoint = CURRENT_CUSTOM,
      token = OLD_TOKEN as string | null,
    } = {}): Promise<void> {
      await browser.storage.local.clear();
      await browser.storage.local.set({
        [USER_ID_KEY]: "1".repeat(64),
        [FAMILY_ID_KEY]: familyId,
        [API_ENDPOINT_KEY]: endpoint,
        ...(token === null
          ? {}
          : { [AUTH_TOKEN_KEY]: token, [TOKEN_EXPIRES_AT_KEY]: 123 }),
      });
    }

    /** A hook bound to FAMILY_ID with the question asked; the call log starts empty. */
    async function askedSwitch() {
      const apiClient = new ApiClient(CURRENT_CUSTOM);
      apiClient.setAuthToken(OLD_TOKEN);
      const hook = renderSwitch(apiClient, {
        familyEndpoint: FAMILY_CUSTOM,
        membersReady: true,
      });
      await waitFor(() => expect(hook.result.current.pending).not.toBeNull());
      const setAuthToken = vi.spyOn(apiClient, "setAuthToken");
      vi.clearAllMocks();
      return { apiClient, setAuthToken, ...hook };
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    it("refuses a confirm after another tab cleared the binding, changing nothing (issue #498)", async () => {
      await seedSession();
      const { apiClient, setAuthToken, result } = await askedSwitch();
      await clearStoredFamilyBinding();
      vi.clearAllMocks();

      await act(async () => result.current.confirm());

      expect(readsWith(PRE_READ_KEYS)).toBe(1);
      await expect(readStored(FAMILY_ID_KEY)).resolves.toBeUndefined();
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      expect(apiClient.getEndpoint()).toBe(CURRENT_CUSTOM);
      expect(setAuthToken).not.toHaveBeenCalled();
      expect(result.current.confirmBindingGone).toBe(true);
      expect(result.current.pending).toBeNull();
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
      expect(setsWith(DECLINED_FAMILY_ENDPOINT_KEY)).toBe(0);
      expect(browser.storage.local.set).not.toHaveBeenCalled();
      expect(browser.storage.local.remove).not.toHaveBeenCalled();
    });

    it("refuses a confirm while storage binds another family, leaving its endpoint and token", async () => {
      await seedSession({
        familyId: OTHER_FAMILY,
        endpoint: OTHER_ENDPOINT,
        token: OTHER_TOKEN,
      });
      const { apiClient, setAuthToken, result } = await askedSwitch();

      await act(async () => result.current.confirm());

      expect(readsWith(PRE_READ_KEYS)).toBe(1);
      await expect(readStored(FAMILY_ID_KEY)).resolves.toBe(OTHER_FAMILY);
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(OTHER_ENDPOINT);
      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBe(OTHER_TOKEN);
      await expect(readStored(TOKEN_EXPIRES_AT_KEY)).resolves.toBe(123);
      expect(browser.storage.local.set).not.toHaveBeenCalled();
      expect(browser.storage.local.remove).not.toHaveBeenCalled();
      expect(apiClient.getEndpoint()).toBe(CURRENT_CUSTOM);
      expect(setAuthToken).not.toHaveBeenCalled();
      expect(result.current.confirmBindingGone).toBe(true);
    });

    it("refuses a confirm when the binding cannot be read, writing nothing", async () => {
      await seedSession();
      const { apiClient, setAuthToken, result } = await askedSwitch();
      vi.mocked(browser.storage.local.get).mockRejectedValueOnce(
        new Error("Extension context invalidated"),
      );

      await act(async () => result.current.confirm());

      expect(browser.storage.local.set).not.toHaveBeenCalled();
      expect(browser.storage.local.remove).not.toHaveBeenCalled();
      expect(apiClient.getEndpoint()).toBe(CURRENT_CUSTOM);
      expect(setAuthToken).not.toHaveBeenCalled();
      expect(result.current.confirmBindingGone).toBe(true);
      expect(result.current.confirmSaveFailed).toBe(false);
      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBe(OLD_TOKEN);
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(CURRENT_CUSTOM);
    });

    it("undoes the write in one removal when the binding is gone after it, keeping the client on the target (5a)", async () => {
      await seedSession();
      const { apiClient, result } = await askedSwitch();
      // Another tab's teardown lands after the pre-write check, before the endpoint write.
      vi.mocked(browser.storage.local.set).mockImplementation(async (items) => {
        if (API_ENDPOINT_KEY in items) {
          await realStoreRemove([FAMILY_ID_KEY, ...UNDO_KEYS]);
        }
        await realStoreSet(items);
      });

      await act(async () => result.current.confirm());

      for (const key of UNDO_KEYS) {
        await expect(readStored(key)).resolves.toBeUndefined();
      }
      expect(removalsWith(API_ENDPOINT_KEY)).toEqual([UNDO_KEYS]);
      const removeOrder = vi.mocked(browser.storage.local.remove).mock
        .invocationCallOrder;
      const reRead = vi
        .mocked(browser.storage.local.get)
        .mock.calls.findIndex(([keys]) => sameKeys(keys, RE_READ_KEYS));
      expect(removeOrder[removeOrder.length - 1]).toBeGreaterThan(
        vi.mocked(browser.storage.local.get).mock.invocationCallOrder[reRead],
      );
      expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
      expect(result.current.confirmBindingGone).toBe(true);
      expect(result.current.confirmSaveFailed).toBe(false);
    });

    it("reports a failed save, keeping the written endpoint, when the read after the write throws (5d)", async () => {
      await seedSession();
      const { apiClient, result } = await askedSwitch();
      vi.mocked(browser.storage.local.get).mockImplementation(async (keys) => {
        if (sameKeys(keys, RE_READ_KEYS)) {
          throw new Error("storage unavailable");
        }
        return realStoreGet(keys);
      });

      await act(async () => result.current.confirm());

      expect(result.current.confirmSaveFailed).toBe(true);
      expect(result.current.confirmBindingGone).toBe(false);
      expect(result.current.adoptedEndpoint).toBe(CURRENT_CUSTOM);
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
      expect(removalsWith(API_ENDPOINT_KEY)).toEqual([]);
      expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
    });

    it("runs a double-clicked confirm once", async () => {
      await seedSession();
      const { apiClient, result } = await askedSwitch();

      await act(async () => {
        result.current.confirm();
        result.current.confirm();
      });

      expect(readsWith(PRE_READ_KEYS)).toBe(1);
      expect(readsWith(RE_READ_KEYS)).toBe(1);
      expect(setsWith(API_ENDPOINT_KEY)).toBe(1);
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
      expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
    });

    it("ignores a decline pressed while a confirm is in flight", async () => {
      await seedSession();
      const { apiClient, result } = await askedSwitch();

      await act(async () => {
        result.current.confirm();
        result.current.decline();
      });

      // A decline on its own does write this key: see "decline keeps the current endpoint".
      expect(setsWith(DECLINED_FAMILY_ENDPOINT_KEY)).toBe(0);
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
      expect(apiClient.getEndpoint()).toBe(FAMILY_CUSTOM);
      expect(result.current.adoptedEndpoint).toBe(FAMILY_CUSTOM);
    });

    it("does nothing when the hook unmounts before the binding read returns", async () => {
      await seedSession();
      const { apiClient, setAuthToken, result, unmount } = await askedSwitch();
      const preRead = deferred<Record<string, unknown>>();
      vi.mocked(browser.storage.local.get).mockImplementationOnce(
        () => preRead.promise,
      );

      act(() => result.current.confirm());
      unmount();
      await act(async () => {
        preRead.resolve({ [FAMILY_ID_KEY]: FAMILY_ID });
        await preRead.promise;
      });

      expect(readsWith(PRE_READ_KEYS)).toBe(1);
      expect(apiClient.getEndpoint()).toBe(CURRENT_CUSTOM);
      expect(setAuthToken).not.toHaveBeenCalled();
      expect(browser.storage.local.set).not.toHaveBeenCalled();
      expect(browser.storage.local.remove).not.toHaveBeenCalled();
    });

    it("drops a token written back during the binding read", async () => {
      await seedSession({ token: null });
      const { result } = await askedSwitch();
      landBefore(PRE_READ_KEYS, () =>
        realStoreSet({
          [AUTH_TOKEN_KEY]: OLD_TOKEN,
          [TOKEN_EXPIRES_AT_KEY]: 456,
        }),
      );

      await act(async () => result.current.confirm());

      expect(readsWith(PRE_READ_KEYS)).toBe(1);
      await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readStored(TOKEN_EXPIRES_AT_KEY)).resolves.toBeUndefined();
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(FAMILY_CUSTOM);
      expect(result.current.confirmBindingGone).toBe(false);
      expect(result.current.confirmSaveFailed).toBe(false);
    });

    it("clears confirmBindingGone through dismissConfirmError", async () => {
      await seedSession({ familyId: OTHER_FAMILY });
      const { result } = await askedSwitch();
      await act(async () => result.current.confirm());
      expect(result.current.confirmBindingGone).toBe(true);

      act(() => result.current.dismissConfirmError());

      expect(result.current.confirmBindingGone).toBe(false);
      expect(result.current.pending).toBeNull();
    });

    it("clears confirmBindingGone on a fresh question, whose confirm then goes through", async () => {
      await seedSession({ familyId: OTHER_FAMILY });
      const { apiClient, result, rerender } = await askedSwitch();
      await act(async () => result.current.confirm());
      expect(result.current.confirmBindingGone).toBe(true);
      await realStoreSet({ [FAMILY_ID_KEY]: FAMILY_ID });

      rerender({ familyEndpoint: "https://moved.example", membersReady: true });
      await waitFor(() =>
        expect(result.current.pending?.targetEndpoint).toBe(
          "https://moved.example",
        ),
      );
      expect(result.current.confirmBindingGone).toBe(false);

      await act(async () => result.current.confirm());

      expect(apiClient.getEndpoint()).toBe("https://moved.example");
      await expect(readStored(API_ENDPOINT_KEY)).resolves.toBe(
        "https://moved.example",
      );
      expect(result.current.confirmBindingGone).toBe(false);
    });
  });
});
