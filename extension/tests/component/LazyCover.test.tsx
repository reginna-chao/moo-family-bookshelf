import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { LazyCover } from "@/dialog/LazyCover";

const SPINNER_STYLE_ID = "moo-lazy-cover-spin";

function removeInjectedKeyframe(): void {
  document.getElementById(SPINNER_STYLE_ID)?.remove();
}

function fallbackDiv() {
  return <div data-testid="fallback">no cover</div>;
}

describe("LazyCover", () => {
  afterEach(() => {
    removeInjectedKeyframe();
  });

  describe("empty src", () => {
    it("renders fallback directly when src is empty string", () => {
      render(
        <LazyCover src="" alt="book" width={40} height={60} fallback={fallbackDiv()} />,
      );

      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("does not show spinner when src is empty", () => {
      const { container } = render(
        <LazyCover src="" alt="book" width={40} height={60} fallback={fallbackDiv()} />,
      );

      expect(container.querySelector('[style*="animation"]')).toBeNull();
    });
  });

  describe("loading state", () => {
    it("renders img with opacity 0 and shows spinner while loading", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="測試書名"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "https://example.com/cover.jpg");
      expect(img.style.opacity).toBe("0");

      const spinner = container.querySelector('[style*="animation"]');
      expect(spinner).not.toBeNull();
    });

    it("sets loading='lazy' and decoding='async' on img", () => {
      render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("decoding", "async");
    });

    it("passes alt attribute correctly", () => {
      render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="測試書名"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      expect(screen.getByAltText("測試書名")).toBeInTheDocument();
    });
  });

  describe("loaded state", () => {
    it("shows img with opacity 1 and removes spinner after load", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      fireEvent.load(screen.getByRole("img"));

      expect(screen.getByRole("img").style.opacity).toBe("1");
      expect(container.querySelector('[style*="animation"]')).toBeNull();
      expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("renders fallback and removes img on error", () => {
      render(
        <LazyCover
          src="https://example.com/broken.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      fireEvent.error(screen.getByRole("img"));

      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });

  describe("keyframe injection", () => {
    it("injects keyframe style element into document head", () => {
      render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      expect(document.getElementById(SPINNER_STYLE_ID)).not.toBeNull();
    });

    it("injects only one style element for multiple instances", () => {
      render(
        <>
          <LazyCover src="https://a.com/1.jpg" alt="a" width={40} height={60} fallback={fallbackDiv()} />
          <LazyCover src="https://b.com/2.jpg" alt="b" width={40} height={60} fallback={fallbackDiv()} />
        </>,
      );

      const styles = document.querySelectorAll(`#${SPINNER_STYLE_ID}`);
      expect(styles).toHaveLength(1);
    });
  });
});
