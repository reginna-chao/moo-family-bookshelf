import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomHostConsent } from "@/components/CustomHostConsent";
import type { SyncCodeApiHostResult } from "@/crypto/syncCode";
import { parseSyncCodeApiHost } from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";

/**
 * The consent gate a QR arrival hits when its sync code carries an `@host`.
 * Without it, the QR path's two zero-interaction exits would adopt someone
 * else's server — and persist it — with the address never shown.
 *
 * This file is the production-anchored home of the gate's OWN copy — the
 * heading, the warning paragraph and the two button labels, each rendered by
 * this component — so `LandingPage.test.tsx` can locate the gate structurally
 * (`data-testid`, button roles) instead of keeping a second copy of that
 * wording where it could drift.
 *
 * One asserted string is NOT this component's: the host note's lead-in belongs
 * to `SyncCodeHostNote`, and its production anchor — including the `join` /
 * `verify` variant pair — lives in `SyncCodeHostNote.test.tsx`. What the
 * assertion here pins is this gate's CHOICE of `variant="verify"` (no sync code
 * is on screen for a QR arrival), not the wording behind it.
 *
 * Presentational: it takes a verdict and two callbacks, which is what keeps the
 * decision of WHEN to ask — and what a "yes" then does — in the caller.
 */
describe("CustomHostConsent", () => {
  const VALID: SyncCodeApiHostResult = {
    kind: "valid",
    endpoint: "https://custom.example.com",
  };

  function renderConsent(result: SyncCodeApiHostResult = VALID) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <CustomHostConsent
        result={result}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    return { onConfirm, onCancel };
  }

  describe("what the user is told", () => {
    it("leads with the fact that the invite points somewhere custom", () => {
      renderConsent();

      expect(screen.getByTestId("custom-host-consent")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        "⚠️ 此邀請指向自訂伺服器",
      );
    });

    it("names the server the join would connect to", () => {
      renderConsent();

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent("將連線至自訂伺服器：");
      // A QR arrival never typed a sync code, so the form's "此同步碼" lead-in
      // would point at something that is not on screen. Its absence is the only
      // thing pinning `variant="verify"`: the join copy CONTAINS the verify
      // copy, so the positive assertion above passes either way.
      expect(note.textContent).not.toContain("此同步碼");
      expect(note).toHaveTextContent("https://custom.example.com");
    });

    it("spells out what would be sent there, including the unshared books", () => {
      renderConsent();

      expect(
        screen.getByText(
          "加入後，你的認證資訊與完整書單（包含未開放的書籍）都會傳送到這個伺服器。請確認你信任這個位址再繼續。",
        ),
      ).toBeInTheDocument();
    });

    it("offers exactly one way forward and one way out", () => {
      renderConsent();

      expect(
        screen.getByRole("button", { name: "確認並加入" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
      expect(screen.getAllByRole("button")).toHaveLength(2);
    });

    /**
     * DOM order is behaviour, not styling: it is the Tab order and the order a
     * screen reader announces the two answers in. Putting refusal first is the
     * deliberate shape for a gate whose whole job is friction — the way out is
     * reached before the way in.
     *
     * Deliberately no assertion on classes or colours: those are implementation
     * detail and would turn every restyle red. The visual half of "equal weight"
     * (matching size, no small grey text link) is therefore NOT covered here.
     */
    it("puts the way out ahead of the way in", () => {
      renderConsent();

      const [first, second] = screen.getAllByRole("button");
      expect(first).toHaveTextContent("取消");
      expect(second).toHaveTextContent("確認並加入");
    });
  });

  describe("answering the gate", () => {
    it("stays silent until one of the buttons is pressed", () => {
      const { onConfirm, onCancel } = renderConsent();

      // Rendering is disclosure, never agreement — the caller must not start
      // any request just because the gate appeared.
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("reports agreement when 確認並加入 is pressed", () => {
      const { onConfirm, onCancel } = renderConsent();

      fireEvent.click(screen.getByRole("button", { name: "確認並加入" }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("reports refusal when 取消 is pressed", () => {
      const { onConfirm, onCancel } = renderConsent();

      fireEvent.click(screen.getByRole("button", { name: "取消" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });

  /**
   * End to end through the real classifier: the address on this screen must be
   * the one `validateEndpointUrl` would hand to the ApiClient. Derived from
   * production rather than hard-coded, so a user who agrees to what is written
   * here cannot be agreeing to a different host than the one contacted.
   */
  describe("driven by the real parseSyncCodeApiHost", () => {
    it.each([
      "https://custom.example.com",
      "https://CUSTOM.Example.COM:443/api/",
      "https://custom.example.com/api",
      "http://nas.local:8787",
    ])("discloses exactly the endpoint %s would be adopted as", (endpoint) => {
      renderConsent(parseSyncCodeApiHost(`moo-ab12-cd34@${endpoint}`));

      expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
        validateEndpointUrl(endpoint),
      );
    });
  });

  /**
   * The caller mounts this only for a `valid` verdict — a refused address is
   * rejected upstream and never reaches a screen offering to accept it. Pinned
   * anyway: if that routing ever slips, the gate must not put a reassuring
   * "connects to" line next to a spoofed host.
   */
  it("never names an address that would be refused", () => {
    renderConsent({ kind: "invalid" });

    expect(screen.queryByTestId("sync-code-host-note")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("sync-code-host-note-invalid"),
    ).toBeInTheDocument();
  });
});
