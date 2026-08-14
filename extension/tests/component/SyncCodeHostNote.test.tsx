import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SyncCodeHostNote } from "@/dialog/SyncCodeHostNote";
import { validateEndpointUrl } from "@/api/client";

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
 * `parseSyncCodeApiHost` stays real here — mocking it would leave the mapping
 * from parse result to rendered copy (the whole component) unverified.
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
      const { container } = render(<SyncCodeHostNote syncCode={syncCode} />);

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("an @host that would be adopted", () => {
    it("names the server the code connects to", () => {
      render(
        <SyncCodeHostNote syncCode="moo-ab12-cd34@https://custom.example.com" />,
      );

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent("此同步碼將連線至自訂伺服器：");
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
      render(<SyncCodeHostNote syncCode={`moo-ab12-cd34@${endpoint}`} />);

      const rendered =
        screen.getByTestId("sync-code-host-note").textContent ?? "";
      // Anchored on production: the displayed value must equal the exact URL
      // validateEndpointUrl would hand to the ApiClient.
      expect(expectedEndpoint).toBe(validateEndpointUrl(endpoint));
      expect(rendered).toContain(expectedEndpoint);
    });

    it("shows the punycode spelling instead of the unicode homograph", () => {
      render(
        <SyncCodeHostNote syncCode="moo-ab12-cd34@https://пример.example" />,
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
        <SyncCodeHostNote syncCode="moo-ab12-cd34@http://nas.local:8787" />,
      );
      const plain = screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(plain).toContain("http://nas.local:8787");
      unmount();

      render(
        <SyncCodeHostNote syncCode="moo-ab12-cd34@https://nas.local:8787" />,
      );
      const secure =
        screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(secure).toContain("https://nas.local:8787");

      expect(plain).not.toBe(secure);
    });

    it("distinguishes two sub-path endpoints sharing one host", () => {
      const { unmount } = render(
        <SyncCodeHostNote syncCode="moo-ab12-cd34@https://shared.example.com/family-a" />,
      );
      const first = screen.getByTestId("sync-code-host-note").textContent ?? "";
      expect(first).toContain("https://shared.example.com/family-a");
      unmount();

      render(
        <SyncCodeHostNote syncCode="moo-ab12-cd34@https://shared.example.com/family-b" />,
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
        <SyncCodeHostNote syncCode="moo-ab12-cd34@https://real.example@evil.com" />,
      );

      const warning = screen.getByTestId("sync-code-host-note-invalid");
      // A security refusal the user must notice before pressing join.
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning).toHaveTextContent(
        "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
      );

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
      render(<SyncCodeHostNote syncCode={`moo-ab12-cd34@${host}`} />);

      expect(
        screen.getByTestId("sync-code-host-note-invalid"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
    });
  });
});
