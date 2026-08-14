import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { SyncCodeHostNote } from "@/components/SyncCodeHostNote";
import { parseSyncCodeApiHost } from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";

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
      expect(note).toHaveTextContent("此同步碼將連線至自訂伺服器：");
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
      expect(warning).toHaveTextContent(
        "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
      );

      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/此同步碼將連線至自訂伺服器/)).toBeNull();
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
