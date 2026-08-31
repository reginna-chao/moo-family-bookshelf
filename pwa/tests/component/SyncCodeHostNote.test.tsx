import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import {
  SyncCodeHostNote,
  type SyncCodeHostNoteProps,
} from "@/components/SyncCodeHostNote";
import {
  parseSyncCodeApiHost,
  type SyncCodeApiHostResult,
} from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";

/**
 * Production copy, pinned as literals ON PURPOSE.
 *
 * The strings themselves now live in `moo-family-bookshelf-shared/hostNote/
 * messages` and BOTH twins import them from there, so the cross-app drift this
 * pin used to be powerless against — Extension copy and PWA copy quietly
 * diverging, each suite green against its own string — is now impossible at the
 * source rather than watched for in review.
 *
 * What the pins still buy is the other direction: importing the shared constants
 * here would compare production with itself and let any reword sail through
 * green. Pinned, a reword has to be made twice — once in shared/, once here —
 * and the Extension twin (extension/tests/component/SyncCodeHostNote.test.tsx)
 * pins the identical set, so it takes four deliberate edits, not a slip.
 */
const JOIN_LEAD_IN = "此同步碼將連線至自訂伺服器：";
const VERIFY_LEAD_IN = "將連線至自訂伺服器：";
const ONBOARDING_LEAD_IN = "目前使用自訂伺服器：";
/** Shared by every variant — deliberately, see the variant block below. */
const INVALID_WARNING = "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認";

/**
 * PWA twin of the Extension's `SyncCodeHostNote`. It is the only thing telling
 * a user that the code they pasted (or the QR they scanned) will send their
 * auth token and full book list to somebody else's server.
 *
 * Contract, identical to the Extension's so the two apps cannot disagree about
 * the same code:
 *
 *   1. A `valid` verdict shows the CANONICAL endpoint — scheme and path
 *      included, never a bare host: `http://nas.local` and `https://nas.local`
 *      are different trust decisions, and two families sharing a host under
 *      different paths are different backends.
 *   2. An `invalid` verdict warns instead, and never echoes the refused
 *      address — reassuring copy attached to a spoofed address is worse than
 *      no copy at all.
 *   3. `none` renders nothing, so the caller can mount it unconditionally.
 *
 * Presentational: the verdict is a prop, which is what lets one component serve
 * both the typed-code form and the verification screen a QR arrival lands on.
 * `variant` follows that same split and changes nothing but the valid branch's
 * lead-in — see "the valid-branch lead-in per variant" below.
 */
describe("SyncCodeHostNote", () => {
  it("renders nothing when the code carries no custom host", () => {
    const { container } = render(
      <SyncCodeHostNote result={{ kind: "none" }} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("an endpoint that would be adopted", () => {
    it("names the server the code connects to", () => {
      render(
        <SyncCodeHostNote
          result={{ kind: "valid", endpoint: "https://custom.example.com" }}
        />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent(JOIN_LEAD_IN);
      expect(note).toHaveTextContent("https://custom.example.com");
      // Informational, not an interruption — only the warning owns role=alert.
      expect(note).not.toHaveAttribute("role", "alert");
      expect(
        screen.queryByTestId("sync-code-host-note-invalid"),
      ).not.toBeInTheDocument();
    });

    it("shows the endpoint verbatim, including scheme and path", () => {
      render(
        <SyncCodeHostNote
          result={{ kind: "valid", endpoint: "http://nas.local:8787/moo" }}
        />,
      );

      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        "http://nas.local:8787/moo",
      );
    });

    it("renders a plain-HTTP LAN endpoint differently from its HTTPS namesake", () => {
      const { unmount } = render(
        <SyncCodeHostNote
          result={{ kind: "valid", endpoint: "http://nas.local:8787" }}
        />,
      );
      const plain = screen.getByTestId("sync-code-host-note").textContent ?? "";
      unmount();

      render(
        <SyncCodeHostNote
          result={{ kind: "valid", endpoint: "https://nas.local:8787" }}
        />,
      );
      const secure =
        screen.getByTestId("sync-code-host-note").textContent ?? "";

      expect(plain).toContain("http://nas.local:8787");
      expect(secure).toContain("https://nas.local:8787");
      expect(plain).not.toBe(secure);
    });
  });

  describe("an endpoint that would be refused", () => {
    it("warns instead of naming a server", () => {
      render(<SyncCodeHostNote result={{ kind: "invalid" }} />);

      const warning = screen.getByTestId("sync-code-host-note-invalid");
      // A security refusal the user must notice before pressing join.
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning).toHaveTextContent(INVALID_WARNING);

      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/此同步碼將連線至自訂伺服器/)).toBeNull();
    });
  });

  /**
   * The lead-in is the ONLY thing `variant` touches, and the boundary is what
   * the user can actually see on the screen the note sits on:
   *
   *   - a sync code is on display (the landing form) → name it, "此同步碼…";
   *   - none is (the verification screen a QR / invite arrival lands on, where
   *     the code was never typed) → drop the mention;
   *   - nothing has happened yet, the note just states the server in force
   *     (`onboarding`) → present tense, "目前使用…".
   *
   * `onboarding` has no PWA call site today — it arrived with the shared copy
   * map for the Extension's onboarding container. It is covered here anyway,
   * because the component accepts it: the PWA must already render it the way the
   * Extension does on the day a PWA screen starts passing it, and a variant that
   * is only exercised on one side is exactly how the two apps would drift back
   * apart.
   *
   * `join` is the DEFAULT so the form's call site needs no prop at all — that
   * default is what this block pins. The invalid branch is deliberately
   * variant-independent: the warning is about the sync code that carried the bad
   * host, and it must read identically wherever it appears.
   *
   * The Extension twin pins the identical set — extension/tests/component/
   * SyncCodeHostNote.test.tsx, "the valid-branch lead-in per variant". Keep the
   * two in step.
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
     * Three variants that render the same sentence would make `variant`
     * decorative and hide a wrong key at a call site; pairwise inequality is the
     * assertion that keeps holding after any one of them is reworded.
     */
    it("gives each variant a lead-in no other variant produces", () => {
      const rendered = (["join", "verify", "onboarding"] as const).map(
        (variant) => textOf(VALID, variant),
      );

      expect(new Set(rendered).size).toBe(rendered.length);
    });

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

  describe("extra layout classes", () => {
    it.each([
      ["valid", { kind: "valid", endpoint: "https://a.example" } as const],
      ["invalid", { kind: "invalid" } as const],
    ])("applies className on the %s variant", (_label, result) => {
      const { container } = render(
        <SyncCodeHostNote result={result} className="mb-4" />,
      );

      expect(container.firstElementChild).toHaveClass("mb-4");
    });

    it("renders without a className", () => {
      render(
        <SyncCodeHostNote
          result={{ kind: "valid", endpoint: "https://a.example" }}
        />,
      );

      expect(screen.getByTestId("sync-code-host-note")).toBeInTheDocument();
    });
  });

  /**
   * End to end through the real classifier: what this note displays must equal
   * the URL `validateEndpointUrl` would hand to the ApiClient. Derived from
   * production rather than hard-coded, so the two cannot drift.
   */
  describe("driven by the real parseSyncCodeApiHost", () => {
    it.each([
      "https://custom.example.com",
      "https://CUSTOM.Example.COM",
      "https://custom.example.com:443",
      "https://custom.example.com/api/",
      "https://пример.example",
      "http://localhost:8787",
    ])("shows exactly the endpoint %s would be adopted as", (endpoint) => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(`moo-ab12-cd34@${endpoint}`)}
        />,
      );

      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        validateEndpointUrl(endpoint),
      );
    });

    it.each([
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["embedded user:password credentials", "https://user:pass@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a non-HTTP scheme", "ftp://files.example.com"],
      ["a bare host with no scheme", "my-worker.example.com"],
    ])("warns about %s without echoing it", (_label, apiHost) => {
      render(
        <SyncCodeHostNote
          result={parseSyncCodeApiHost(`moo-ab12-cd34@${apiHost}`)}
        />,
      );

      const warning = screen.getByTestId("sync-code-host-note-invalid");
      expect(warning.textContent).not.toContain("evil.com");
      expect(warning.textContent).not.toContain("real.example");
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
    });

    it.each([
      ["a default-endpoint code", "moo-ab12-cd34"],
      ["a code still being typed", "moo-ab12"],
      ["an empty input", ""],
    ])("renders nothing for %s", (_label, code) => {
      const { container } = render(
        <SyncCodeHostNote result={parseSyncCodeApiHost(code)} />,
      );

      expect(container).toBeEmptyDOMElement();
    });
  });
});
