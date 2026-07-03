import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LazyCover } from "@/dialog/LazyCover";

const SPIN_KEYFRAME = "@keyframes moo-lazy-spin";

/** Find the spinner element (visible only while status === "loading"), if present. */
function spinnerIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".moo-lazy-cover__spinner");
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

      // Empty src renders only the fallback — no wrapper, so no spinner element.
      expect(spinnerIn(container)).toBeNull();
    });
  });

  describe("loading state", () => {
    it("renders the not-yet-loaded img and shows the spinner while loading", () => {
      // The opacity-0 → opacity-1 fade moved from inline `style.opacity` to the
      // `.moo-lazy-cover__img--loaded` modifier in styles.css. jsdom does not
      // apply stylesheet rules, so the observable contracts are: (a) the img
      // carries the base class WITHOUT the --loaded modifier while loading, and
      // (b) the spinner element (`.moo-lazy-cover__spinner`) is present.
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
      expect(img).toHaveClass("moo-lazy-cover__img");
      expect(img).not.toHaveClass("moo-lazy-cover__img--loaded");

      expect(spinnerIn(container)).not.toBeNull();
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
    it("adds the --loaded modifier to the img and removes the spinner after load", () => {
      // After load the img gains `.moo-lazy-cover__img--loaded` (opacity → 1 in
      // styles.css) and the spinner element is unmounted.
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

      expect(screen.getByRole("img")).toHaveClass("moo-lazy-cover__img--loaded");
      expect(spinnerIn(container)).toBeNull();
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

  describe("spinner lifecycle", () => {
    // The spinner keyframes moved from an in-tree <style> into styles.css
    // (`@keyframes moo-lazy-spin`, applied via `.moo-lazy-cover__spinner`).
    // LazyCover no longer renders any <style> block, so the spinner ELEMENT's
    // presence (only while status === "loading") is the observable contract.
    it("renders the spinner element while loading", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      expect(spinnerIn(container)).not.toBeNull();
    });

    it("never injects a keyframe <style> into document.head", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      // Neither document.head nor the component subtree carries an inline
      // @keyframes block — the animation is defined once in styles.css.
      const headStyles = Array.from(document.head.querySelectorAll("style")).filter(
        (el) => el.textContent?.includes(SPIN_KEYFRAME),
      );
      expect(headStyles).toHaveLength(0);
      const subtreeStyles = Array.from(container.querySelectorAll("style")).filter(
        (el) => el.textContent?.includes(SPIN_KEYFRAME),
      );
      expect(subtreeStyles).toHaveLength(0);
    });

    it("removes the spinner element once the image has loaded", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );
      expect(spinnerIn(container)).not.toBeNull();

      fireEvent.load(screen.getByRole("img"));

      expect(spinnerIn(container)).toBeNull();
    });
  });
});
