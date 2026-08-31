import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import {
  SyncCodeHostNote,
  type SyncCodeHostNoteProps,
} from "@/dialog/SyncCodeHostNote";
import {
  parseSyncCodeApiHost,
  type SyncCodeApiHostResult,
} from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";

/**
 * Production copy, pinned as literals ON PURPOSE. The strings now live in
 * `moo-family-bookshelf-shared/hostNote/messages` and both twins import them
 * from there, so importing them HERE too would compare production with itself
 * and let any reword sail through green. Pinned, a reword has to be made twice
 * — once in shared/, once here — which is the point.
 *
 * The PWA twin renders the SAME three lead-ins from that same shared module and
 * pins its own copy of this set (pwa/tests/component/SyncCodeHostNote.test.tsx).
 * Cross-app drift is now impossible at the source; these pins guard the
 * remaining direction — copy changing without anyone deciding to change it.
 */
const JOIN_LEAD_IN = "此同步碼將連線至自訂伺服器：";
const VERIFY_LEAD_IN = "將連線至自訂伺服器：";
const ONBOARDING_LEAD_IN = "目前使用自訂伺服器：";
/** Shared by every variant — deliberately, see the variant block below. */
const INVALID_WARNING = "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認";

/**
 * SyncCodeHostNote is the ONLY thing standing between a pasted `@host` sync code
 * and a user who cannot read URLs. Its security contract:
 *
 *   1. What it displays must be the ENDPOINT the client would actually adopt —
 *      the canonical `origin + pathname` (lowercase / punycode / no default
 *      port / no trailing slash), never the raw text and never a bare host.
 *      Scheme and path are part of the answer: `http://nas.local` and
 *      `https://nas.local` are different trust decisions, and two families
 *      sharing a host under different paths are different backends.
 *   2. A `@host` that would be REFUSED on adoption gets a warning, never the
 *      reassuring "will connect to …" line; reassuring copy attached to a
 *      spoofed address is worse than no copy at all.
 *   3. Nothing at all for a default-endpoint (or still-being-typed) code.
 *
 * The component is PRESENTATIONAL — the verdict arrives as a prop, which is what
 * lets one component serve the join screens (verdict from the typed code), the
 * two secret-collecting screens (the onboarding verification challenge and the
 * re-auth modal) and the onboarding container's status note, whose verdict is
 * the endpoint the client has ALREADY adopted and where no sync code is on
 * display at all. Most cases below still drive it through the real
 * `parseSyncCodeApiHost`: mocking the parse would leave the mapping from verdict
 * to rendered copy — the whole component — unverified.
 *
 * `variant` follows exactly that boundary and changes NOTHING else: whether a
 * sync code is visible on the screen decides whether the valid branch's lead-in
 * names one (`join`, the default, so the three join call sites need no prop) or
 * drops the mention (`verify` before handing over a secret, `onboarding` for the
 * container's plain statement of where the buttons below will connect). The
 * invalid branch's warning is shared by every variant by decision, not omission
 * — see "the valid-branch lead-in per variant" below.
 */
describe("SyncCodeHostNote", () => {
  describe("no custom host", () => {
    it.each([
      ["the input is empty", ""],
      ["the code carries no @host", "moo-ab12-cd34"],
      ["the code is still being typed", "moo-ab12"],
      ["the @ has no host after it yet", "moo-ab12-cd34@"],
      ["the prefix is wrong", "foo-ab12-cd34@https://custom.example.com"],
    ])("renders nothing when %s", (_label, syncCode) => {
      const { container } = render(
        <SyncCodeHostNote result={parseSyncCodeApiHost(syncCode)} />,
      );

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("an @host that would be adopted", () => {
    it("names the server the code connects to", () => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(
            "moo-ab12-cd34@https://custom.example.com",
          )}
        />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent(JOIN_LEAD_IN);
      expect(note).toHaveTextContent("https://custom.example.com");
      // Informational, not an interruption — the warning variant owns role=alert.
      expect(note).not.toHaveAttribute("role", "alert");
      expect(
        screen.queryByTestId("sync-code-host-note-invalid"),
      ).not.toBeInTheDocument();
    });

    it.each([
      [
        "an upper-case host",
        "https://CUSTOM.Example.COM",
        "https://custom.example.com",
      ],
      [
        "an IDN host, shown in punycode",
        "https://пример.example",
        "https://xn--e1afmkfd.example",
      ],
      [
        "an explicit default port, dropped",
        "https://custom.example.com:443",
        "https://custom.example.com",
      ],
      [
        "a non-default port, kept",
        "https://custom.example.com:8443",
        "https://custom.example.com:8443",
      ],
      [
        "a URL with a path, path kept",
        "https://custom.example.com/api",
        "https://custom.example.com/api",
      ],
      [
        "a trailing slash, stripped",
        "https://custom.example.com/api/",
        "https://custom.example.com/api",
      ],
      [
        "a localhost dev endpoint",
        "http://localhost:8787",
        "http://localhost:8787",
      ],
    ])("normalizes %s", (_label, endpoint, expectedEndpoint) => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(`moo-ab12-cd34@${endpoint}`)}
        />,
      );

      const rendered =
        screen.getByTestId("sync-code-host-note").textContent ?? "";
      // Anchored on production: the displayed value must equal the exact URL
      // validateEndpointUrl would hand to the ApiClient.
      expect(expectedEndpoint).toBe(validateEndpointUrl(endpoint));
      expect(rendered).toContain(expectedEndpoint);
    });

    it("shows the punycode spelling instead of the unicode homograph", () => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost("moo-ab12-cd34@https://пример.example")}
        />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent("xn--e1afmkfd.example");
      expect(note.textContent).not.toContain("пример");
    });

    /**
     * A host-only note read identically for both of these, which is the one
     * difference a user most needs to see: one sends the auth token and the
     * whole book list over the LAN in the clear.
     */
    it("renders a plain-HTTP LAN endpoint differently from its HTTPS namesake", () => {
      const { unmount } = render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost("moo-ab12-cd34@http://nas.local:8787")}
        />,
      );
      const plain = screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(plain).toContain("http://nas.local:8787");
      unmount();

      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost("moo-ab12-cd34@https://nas.local:8787")}
        />,
      );
      const secure =
        screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(secure).toContain("https://nas.local:8787");

      expect(plain).not.toBe(secure);
    });

    it("distinguishes two sub-path endpoints sharing one host", () => {
      const { unmount } = render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(
            "moo-ab12-cd34@https://shared.example.com/family-a",
          )}
        />,
      );
      const first = screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(first).toContain("https://shared.example.com/family-a");
      unmount();

      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(
            "moo-ab12-cd34@https://shared.example.com/family-b",
          )}
        />,
      );
      const second =
        screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(second).toContain("https://shared.example.com/family-b");

      expect(first).not.toBe(second);
    });
  });

  describe("an @host that would be refused", () => {
    it("warns instead of naming the server", () => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(
            "moo-ab12-cd34@https://real.example@evil.com",
          )}
        />,
      );

      const warning = screen.getByTestId("sync-code-host-note-invalid");
      // A security refusal the user must notice before pressing join.
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning).toHaveTextContent(INVALID_WARNING);

      // The reassuring line must not appear alongside it.
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/此同步碼將連線至自訂伺服器/)).toBeNull();
      // Neither the masqueraded name nor the host it would really reach.
      expect(warning.textContent).not.toContain("real.example");
      expect(warning.textContent).not.toContain("evil.com");
    });

    it.each([
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["embedded user:password credentials", "https://user:pass@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a non-HTTP scheme", "ftp://files.example.com"],
      ["a javascript: URL", "javascript:alert(1)"],
      ["a bare host with no scheme", "my-worker.example.com"],
    ])("warns about %s", (_label, host) => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(`moo-ab12-cd34@${host}`)}
        />,
      );

      expect(
        screen.getByTestId("sync-code-host-note-invalid"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * The secret-collecting screens have no sync code on them: the user typed the
   * code on a PREVIOUS screen (onboarding's verification challenge) or days
   * earlier (the re-auth modal), the client has already adopted its `@host`, and
   * now a PIN/pattern is about to be handed to that server. So the caller
   * classifies the ADOPTED endpoint instead of parsing text, and asks for the
   * `verify` copy — see dialog/Onboarding.tsx's verify-prompt branch and
   * dialog/ReauthModal.tsx.
   */
  describe("a verdict classified from an adopted endpoint (no sync code)", () => {
    it("names the endpoint the client has already adopted", () => {
      render(
        <SyncCodeHostNote
          result={classifySyncCodeApiHost("https://nas.example.com/moo/")}
          variant="verify"
        />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent(VERIFY_LEAD_IN);
      // Nothing on this screen is a sync code, so claiming one would send the
      // user looking for something that is not there.
      expect(note.textContent).not.toContain("此同步碼");
      // Canonical, exactly as the ApiClient stores it — trailing slash gone.
      expect(note).toHaveTextContent(
        validateEndpointUrl("https://nas.example.com/moo/"),
      );
    });

    /**
     * A create/lookup-triggered challenge — and every re-auth on the official
     * Worker — is still on the default endpoint, and the caller passes
     * `undefined` for it. Silence is the whole point: a note on every challenge
     * would train the user to ignore it.
     */
    it("renders nothing when the caller supplies no endpoint", () => {
      const { container } = render(
        <SyncCodeHostNote
          result={classifySyncCodeApiHost(undefined)}
          variant="verify"
        />,
      );

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("warns without echoing an adopted endpoint that would be refused", () => {
      render(
        <SyncCodeHostNote
          result={classifySyncCodeApiHost("https://real.example@evil.com")}
          variant="verify"
        />,
      );

      const warning = screen.getByTestId("sync-code-host-note-invalid");
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning.textContent).not.toContain("real.example");
      expect(warning.textContent).not.toContain("evil.com");
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * The lead-in is the ONLY thing `variant` touches, and the boundary is what
   * the user can actually see on the screen the note sits on:
   *
   *   - a sync code is on display (the join screens) → name it, "此同步碼…";
   *   - none is (the verification challenge, the re-auth modal) → drop the
   *     mention, because there is no code on screen for the user to look at;
   *   - nothing has happened yet (the onboarding container's status note, which
   *     sits above whichever step is showing) → present tense, "目前使用…",
   *     because it reports a standing fact rather than a pending connection.
   *
   * `join` is the DEFAULT so the three join call sites keep working with no prop
   * at all — that default is what this block pins. The invalid branch is
   * deliberately variant-independent: the warning is about the sync code that
   * carried the bad host, and it must read identically wherever it appears.
   */
  describe("the valid-branch lead-in per variant", () => {
    const VALID: SyncCodeApiHostResult = {
      kind: "valid",
      endpoint: "https://nas.example.com/moo",
    };
    const INVALID: SyncCodeApiHostResult = { kind: "invalid" };

    /** Full rendered text of one note, mounted and torn down in isolation. */
    function textOf(
      result: SyncCodeApiHostResult,
      variant?: SyncCodeHostNoteProps["variant"],
    ): string {
      const { container, unmount } = render(
        <SyncCodeHostNote result={result} variant={variant} />,
      );
      const text = (container.textContent ?? "").trim();
      unmount();
      return text;
    }

    it.each([
      ["join", "join" as const, JOIN_LEAD_IN],
      ["verify", "verify" as const, VERIFY_LEAD_IN],
      ["onboarding", "onboarding" as const, ONBOARDING_LEAD_IN],
    ])("names the server with the %s lead-in", (_label, variant, leadIn) => {
      // Exact equality, not `toContain`: the join copy CONTAINS the verify copy,
      // so a substring assertion cannot tell the two variants apart.
      expect(textOf(VALID, variant)).toBe(`${leadIn}${VALID.endpoint}`);
    });

    it("drops the sync-code mention on the verify and onboarding variants", () => {
      expect(textOf(VALID, "verify")).not.toContain("此同步碼");
      expect(textOf(VALID, "onboarding")).not.toContain("此同步碼");
      expect(textOf(VALID, "join")).toContain("此同步碼");
    });

    /**
     * The onboarding container's note and the challenge's note answer DIFFERENT
     * questions about the same address ("which server am I on" vs "which server
     * is about to receive this PIN"), and dialog/Onboarding.tsx can put the
     * container's note on screen at the same time as the join screen's. Three
     * variants that render the same sentence would make `variant` decorative and
     * hide a wrong key at the call site; pairwise inequality is the assertion
     * that keeps holding after any one of them is reworded.
     */
    it("gives each variant a lead-in no other variant produces", () => {
      const rendered = (["join", "verify", "onboarding"] as const).map(
        (variant) => textOf(VALID, variant),
      );

      expect(new Set(rendered).size).toBe(rendered.length);
    });

    /**
     * Exactly three call sites mount the note WITHOUT a variant: the Extension's
     * idle join screen (dialog/IdleView.tsx), its recovery join view
     * (dialog/RecoveryJoinView.tsx) and the PWA's sync-code form
     * (pwa/src/pages/LandingPage.tsx). They read correctly only because the
     * default is `join`, so flipping that default would silently reword those
     * three screens.
     */
    it("defaults to the join lead-in when no variant is given", () => {
      expect(textOf(VALID)).toBe(textOf(VALID, "join"));
      expect(textOf(VALID)).toContain(JOIN_LEAD_IN);
    });

    /**
     * A decision, not an omission: the warning names the sync code because that
     * is what carried the refused host, and a caller asking for `verify` copy
     * must not get a softened version of a security refusal.
     */
    it("warns identically on every variant", () => {
      const onJoin = textOf(INVALID, "join");

      expect(textOf(INVALID, "verify")).toBe(onJoin);
      expect(textOf(INVALID, "onboarding")).toBe(onJoin);
      expect(textOf(INVALID)).toBe(onJoin);
      expect(onJoin).toBe(INVALID_WARNING);
    });
  });

  /**
   * `className` carries LAYOUT only — the caller decides spacing, the component
   * keeps its own palette/size classes. The screens that mount the note OUTSIDE
   * the container that would otherwise supply the gutter are the reason the prop
   * exists: `.moo-onboarding-view` on the challenge, `.moo-modal`'s padding flow
   * on the re-auth modal, and the onboarding container, whose note precedes
   * `.moo-onboarding-view` entirely — so each passes its own spacing modifier.
   */
  describe("extra layout classes", () => {
    /** The modifiers the three production call sites actually pass. */
    const LAYOUT_CLASSES = [
      ["the onboarding challenge", "moo-sync-host-note--verify"],
      ["the re-auth modal", "moo-sync-host-note--reauth"],
      ["the onboarding container", "moo-sync-host-note--onboarding"],
    ] as const;

    function classesOf(
      result: SyncCodeApiHostResult,
      className?: string,
    ): string[] {
      const { container, unmount } = render(
        <SyncCodeHostNote result={result} className={className} />,
      );
      const classes = Array.from(
        container.firstElementChild?.classList ?? [],
      ) as string[];
      unmount();
      return classes;
    }

    const variants: Array<[string, SyncCodeApiHostResult]> = [
      ["valid", { kind: "valid", endpoint: "https://a.example" }],
      ["invalid", { kind: "invalid" }],
    ];

    const layoutCases: Array<[string, string, string, SyncCodeApiHostResult]> =
      LAYOUT_CLASSES.flatMap(([site, layoutClass]) =>
        variants.map(
          ([label, result]) =>
            [label, site, layoutClass, result] as [
              string,
              string,
              string,
              SyncCodeApiHostResult,
            ],
        ),
      );

    it.each(layoutCases)(
      "keeps the %s variant's own classes while adding %s's layout class",
      (_label, _site, layoutClass, result) => {
        const bare = classesOf(result);
        const withLayout = classesOf(result, layoutClass);

        expect(bare).not.toContain(layoutClass);
        expect(withLayout).toEqual(expect.arrayContaining(bare));
        expect(withLayout).toContain(layoutClass);
        expect(withLayout).toHaveLength(bare.length + 1);
      },
    );

    it.each(variants)(
      "renders the %s variant unchanged when no className is given",
      (_label, result) => {
        // No stray trailing space / empty class token from the default "".
        const bare = classesOf(result);

        expect(bare.length).toBeGreaterThan(0);
        expect(bare).not.toContain("");
      },
    );
  });
});
