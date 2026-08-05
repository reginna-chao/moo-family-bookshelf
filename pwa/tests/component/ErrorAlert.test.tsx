import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { ErrorAlert } from "@/components/ErrorAlert";

const MESSAGE = "驗證錯誤次數過多，請於 1 分 30 秒後再試。";
const ANNOUNCEMENT = "驗證錯誤次數過多，請稍後再試。";

describe("ErrorAlert", () => {
  describe("nothing to show", () => {
    it.each<[string, string | undefined]>([
      ["no announcement", undefined],
      ["an announcement", ANNOUNCEMENT],
    ])(
      "renders nothing for an empty message with %s",
      (_label, announcement) => {
        const { container } = render(
          <ErrorAlert message="" announcement={announcement} />,
        );

        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      },
    );
  });

  describe("static copy", () => {
    it("announces the visible message from a single live region", () => {
      render(<ErrorAlert message={ANNOUNCEMENT} />);

      const alert = screen.getByRole("alert");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(alert.textContent).toBe(ANNOUNCEMENT);
      expect(alert).toBeVisible();
      expect(alert).not.toHaveAttribute("aria-hidden");
    });

    it.each<[string, string | undefined]>([
      ["an identical announcement", ANNOUNCEMENT],
      ["an empty announcement", ""],
    ])("keeps a single node when given %s", (_label, announcement) => {
      const { container } = render(
        <ErrorAlert message={ANNOUNCEMENT} announcement={announcement} />,
      );

      expect(container.querySelectorAll("p")).toHaveLength(1);
      expect(screen.getByRole("alert").textContent).toBe(ANNOUNCEMENT);
      expect(container.textContent).toBe(ANNOUNCEMENT);
    });
  });

  describe("ticking copy", () => {
    it("announces the stable sentence and hides the ticking one from AT", () => {
      render(<ErrorAlert message={MESSAGE} announcement={ANNOUNCEMENT} />);

      const alert = screen.getByRole("alert");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(alert.textContent).toBe(ANNOUNCEMENT);
      expect(alert).toHaveClass("sr-only");

      const visible = screen.getByText(MESSAGE);
      expect(visible).toHaveAttribute("aria-hidden", "true");
      expect(visible).not.toHaveAttribute("role");
    });

    it("keeps the ticking sentence out of the live region", () => {
      render(<ErrorAlert message={MESSAGE} announcement={ANNOUNCEMENT} />);

      expect(screen.getByRole("alert").textContent).not.toContain("1 分 30 秒");
    });

    it("still shows the visible message to sighted users", () => {
      const { container } = render(
        <ErrorAlert message={MESSAGE} announcement={ANNOUNCEMENT} />,
      );

      expect(screen.getByText(MESSAGE)).toBeInTheDocument();
      expect(container.textContent).toBe(`${ANNOUNCEMENT}${MESSAGE}`);
    });
  });

  describe("layout classes", () => {
    it.each<[string, string | undefined]>([
      ["static copy", undefined],
      ["ticking copy", ANNOUNCEMENT],
    ])("appends the caller's spacing class for %s", (_label, announcement) => {
      const { container } = render(
        <ErrorAlert
          message={MESSAGE}
          announcement={announcement}
          className="mb-3"
        />,
      );

      const paragraph = container.querySelector("p");
      expect(paragraph).toHaveClass("mb-3");
      expect(paragraph).toHaveClass("text-red-500");
    });
  });
});
