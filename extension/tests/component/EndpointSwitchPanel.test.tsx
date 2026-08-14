import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  EndpointSwitchPanel,
  type EndpointSwitchPanelProps,
} from "@/dialog/EndpointSwitchPanel";
import type { PendingEndpointSwitch } from "@/dialog/useEndpointSwitch";
import { DEFAULT_API_ENDPOINT } from "@/constants";

/**
 * Presentational contract of the family endpoint-switch panel.
 *
 * The decision logic is covered in tests/unit/dialog/useEndpointSwitch.test.ts
 * and the end-to-end wiring in tests/component/FamilySettings.test.tsx. What
 * only this file can reach is the panel's own branch selection, driven purely
 * by props: which of the three states (nothing / question / failure notice) it
 * renders, and which callback each button fires.
 */

const CURRENT_ENDPOINT = "https://current.example";
const FAMILY_ENDPOINT = "https://family.example";
/**
 * A record value `validateEndpointUrl` refuses: the userinfo makes the string
 * READ as family.example while the browser would fetch evil.com. The family
 * owner controls this field, so it is exactly the shape a malicious owner
 * plants — and exactly the string the panel must not print.
 */
const REFUSED_ENDPOINT = "https://family.example@evil.com";

const customSwitch: PendingEndpointSwitch = {
  current: CURRENT_ENDPOINT,
  target: FAMILY_ENDPOINT,
  targetEndpoint: FAMILY_ENDPOINT,
  isDefaultTarget: false,
  targetValid: true,
};

const revertSwitch: PendingEndpointSwitch = {
  current: CURRENT_ENDPOINT,
  target: null,
  targetEndpoint: DEFAULT_API_ENDPOINT,
  isDefaultTarget: true,
  targetValid: true,
};

const refusedSwitch: PendingEndpointSwitch = {
  current: CURRENT_ENDPOINT,
  target: REFUSED_ENDPOINT,
  targetEndpoint: REFUSED_ENDPOINT,
  isDefaultTarget: false,
  targetValid: false,
};

function renderPanel(props: Partial<EndpointSwitchPanelProps> = {}) {
  const handlers = {
    onConfirm: vi.fn(),
    onDecline: vi.fn(),
    onDismissConfirmError: vi.fn(),
  };
  const result = render(
    <EndpointSwitchPanel
      pending={null}
      confirmError={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...result, ...handlers };
}

describe("EndpointSwitchPanel", () => {
  // FamilySettings mounts the panel unconditionally (same shape as
  // VersionWarning), so "nothing to say" has to render as literally nothing —
  // otherwise an empty amber box would sit above the Settings tab forever.
  it("renders nothing when there is neither a question nor a failure notice", () => {
    const { container } = renderPanel();

    expect(container).toBeEmptyDOMElement();
  });

  describe("pending question", () => {
    it("announces the switch and shows both endpoints", () => {
      renderPanel({ pending: customSwitch });

      const panel = screen.getByTestId("endpoint-switch");
      // It interrupts the Settings tab with a security decision, so assistive
      // tech is told the moment it appears.
      expect(panel).toHaveAttribute("role", "alert");
      expect(screen.getByText("⚠️ 家庭 API 端點已變更")).toBeInTheDocument();
      expect(screen.getByText(CURRENT_ENDPOINT)).toBeInTheDocument();
      expect(screen.getByText(FAMILY_ENDPOINT)).toBeInTheDocument();
    });

    it("labels a custom target plainly", () => {
      renderPanel({ pending: customSwitch });

      expect(screen.getByText("將切換至")).toBeInTheDocument();
      expect(
        screen.queryByText("將切換至（官方預設端點）"),
      ).not.toBeInTheDocument();
    });

    it("marks a revert to the official default in the target label", () => {
      renderPanel({ pending: revertSwitch });

      expect(screen.getByText("將切換至（官方預設端點）")).toBeInTheDocument();
      expect(screen.queryByText("將切換至")).not.toBeInTheDocument();
      expect(screen.getByText(DEFAULT_API_ENDPOINT)).toBeInTheDocument();
    });

    it("offers the safe choice first", () => {
      renderPanel({ pending: customSwitch });

      expect(
        screen.getAllByRole("button").map((btn) => btn.textContent),
      ).toEqual(["暫不切換", "確認切換"]);
    });

    it("fires only onDecline for 暫不切換", () => {
      const { onConfirm, onDecline, onDismissConfirmError } = renderPanel({
        pending: customSwitch,
      });

      fireEvent.click(screen.getByText("暫不切換"));

      expect(onDecline).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onDismissConfirmError).not.toHaveBeenCalled();
    });

    it("fires only onConfirm for 確認切換", () => {
      const { onConfirm, onDecline, onDismissConfirmError } = renderPanel({
        pending: customSwitch,
      });

      fireEvent.click(screen.getByText("確認切換"));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onDecline).not.toHaveBeenCalled();
      expect(onDismissConfirmError).not.toHaveBeenCalled();
    });
  });

  /**
   * A target the client's own validation would REFUSE is never printed.
   * Rendering `https://family.example@evil.com` under 「將切換至」 dresses a
   * spoofed address up as a legitimate destination on the exact screen where
   * the user decides whether to trust it — the panel is the last thing standing
   * between the owner's chosen string and the member's eyes.
   */
  describe("a target the validator would refuse", () => {
    it("withholds the address and warns in its place", () => {
      renderPanel({ pending: refusedSwitch });

      const notice = screen.getByTestId("endpoint-switch-invalid-target");
      expect(notice).toHaveTextContent(
        "⚠️ 此位址無效或不安全，無法切換，請向家庭管理者確認",
      );
    });

    it("never prints the refused address anywhere in the panel", () => {
      renderPanel({ pending: refusedSwitch });

      const panel = screen.getByTestId("endpoint-switch");
      const text = panel.textContent ?? "";
      // Neither the masqueraded name the string reads as, nor the host the
      // browser would really reach, nor the raw value.
      expect(text).not.toContain(REFUSED_ENDPOINT);
      expect(text).not.toContain("evil.com");
      expect(text).not.toContain("family.example");
      // The endpoint actually in effect is still shown — that one is trusted.
      expect(text).toContain(CURRENT_ENDPOINT);
    });

    it("labels the withheld value as the family's choice, not as a destination", () => {
      renderPanel({ pending: refusedSwitch });

      expect(screen.getByText("家庭指定的位址")).toBeInTheDocument();
      expect(screen.queryByText("將切換至")).not.toBeInTheDocument();
      expect(
        screen.queryByText("將切換至（官方預設端點）"),
      ).not.toBeInTheDocument();
    });

    it("announces itself, so the refusal is not missed by assistive tech", () => {
      renderPanel({ pending: refusedSwitch });

      // The root already carries role=alert; the warning lives inside it, so
      // the whole panel is announced as one region rather than twice.
      expect(screen.getByTestId("endpoint-switch")).toHaveAttribute(
        "role",
        "alert",
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    });

    it("keeps both buttons live so confirming fails closed into the notice", () => {
      const { onConfirm, onDecline } = renderPanel({ pending: refusedSwitch });

      // Disabling 確認切換 would leave the user with no way to reach the
      // refusal notice, which is where the failure is actually explained.
      expect(
        screen.getAllByRole("button").map((btn) => btn.textContent),
      ).toEqual(["暫不切換", "確認切換"]);

      fireEvent.click(screen.getByText("確認切換"));
      expect(onConfirm).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByText("暫不切換"));
      expect(onDecline).toHaveBeenCalledTimes(1);
    });

    it("shows the valid target verbatim, so the withholding is specific to a refusal", () => {
      renderPanel({ pending: customSwitch });

      expect(screen.getByText(FAMILY_ENDPOINT)).toBeInTheDocument();
      expect(
        screen.queryByTestId("endpoint-switch-invalid-target"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("家庭指定的位址")).not.toBeInTheDocument();
    });
  });

  /**
   * A confirmation the client's own URL validation then refuses leaves the
   * member on the old endpoint. The panel simply closing would read as
   * "switched successfully", so the refusal gets said out loud instead.
   */
  describe("confirmError notice", () => {
    it("states the refusal and announces it", () => {
      renderPanel({ confirmError: true });

      const notice = screen.getByTestId("endpoint-switch-error");
      expect(notice).toHaveAttribute("role", "alert");
      expect(
        screen.getByText(
          "此位址無法使用（需為 HTTPS，或本機／私人網路的 HTTP），已略過此次切換。",
        ),
      ).toBeInTheDocument();
    });

    it("fires only onDismissConfirmError for 知道了", () => {
      const { onConfirm, onDecline, onDismissConfirmError } = renderPanel({
        confirmError: true,
      });

      fireEvent.click(screen.getByText("知道了"));

      expect(onDismissConfirmError).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onDecline).not.toHaveBeenCalled();
    });

    // The hook keeps the two mutually exclusive, but the panel must not depend
    // on that: an unreported failed switch is the more urgent thing to say, and
    // showing both would offer 確認切換 for a question already answered.
    it("takes precedence over a still-pending question", () => {
      renderPanel({ pending: customSwitch, confirmError: true });

      expect(screen.getByTestId("endpoint-switch-error")).toBeInTheDocument();
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      expect(screen.queryByText("確認切換")).not.toBeInTheDocument();
      expect(screen.queryByText("暫不切換")).not.toBeInTheDocument();
    });
  });
});
