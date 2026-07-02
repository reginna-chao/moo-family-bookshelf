import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LazyCover } from "@/dialog/LazyCover";

const SPIN_KEYFRAME = "@keyframes moo-lazy-spin";

/** Find the in-tree <style> that defines the spinner keyframes, if present. */
function keyframeStyleIn(container: HTMLElement): HTMLStyleElement | null {
  const match = Array.from(container.querySelectorAll("style")).find((el) =>
    el.textContent?.includes(SPIN_KEYFRAME),
  );
  return match ?? null;
}

function fallbackDiv() {
  return <div data-testid="fallback">no cover</div>;
}

describe("LazyCover", () => {
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

  describe("keyframe rendering", () => {
    // Keyframes are rendered as an in-tree <style> (so they resolve inside the
    // shadow root) rather than injected into document.head. They exist only while
    // the spinner is visible (status === "loading").
    it("renders the spinner keyframes as an in-tree style while loading", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      expect(keyframeStyleIn(container)).not.toBeNull();
    });

    it("does not inject the keyframes into document.head", () => {
      render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      const headStyles = Array.from(document.head.querySelectorAll("style")).filter(
        (el) => el.textContent?.includes(SPIN_KEYFRAME),
      );
      expect(headStyles).toHaveLength(0);
    });

    it("removes the keyframe style once the image has loaded", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );
      expect(keyframeStyleIn(container)).not.toBeNull();

      fireEvent.load(screen.getByRole("img"));

      expect(keyframeStyleIn(container)).toBeNull();
    });
  });
});
