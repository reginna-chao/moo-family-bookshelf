import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { LazyCover } from "@/components/LazyCover";

/**
 * LazyCover (PWA): the lazily loaded cover image, its loading placeholder, the fade-in on load
 * (`opacity-0` → `opacity-100`) and the fallback on error / empty src.
 *
 * Placeholder probe: the loading overlay is the only `aria-hidden="true"` div inside the wrapper —
 * a fallback icon's `aria-hidden` sits on its `<svg>`, and this file's fallback carries none — so
 * `div[aria-hidden="true"]` finds it without pinning its Tailwind classes.
 *
 * Static placeholder (#430): the img is `loading="lazy"`, so an off-screen cover never fires `load`
 * and stays in "loading" for as long as the page is open. The old overlay held an `animate-spin`
 * circle, so every off-screen cover animated forever. The overlay is now a static grey box: while
 * loading, no element in the subtree may carry an `animate-` class (`animate-spin`, `animate-pulse`,
 * …). The positive companion (the overlay is present) keeps that negative check from passing on a
 * cover that is not in "loading" at all.
 */

/** The loading overlay (rendered only while status === "loading"), if present.
 *  See the header → "Placeholder probe". */
function placeholderIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('div[aria-hidden="true"]');
}

/** Class tokens in the subtree that animate. See the header → "Static placeholder". */
function animatedClassesIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("*"))
    .flatMap((el) => Array.from(el.classList))
    .filter((name) => name.includes("animate-"));
}

function fallbackDiv() {
  return <div data-testid="fallback">no cover</div>;
}

describe("LazyCover", () => {
  describe("empty src", () => {
    it("renders fallback directly when src is empty string", () => {
      render(<LazyCover src="" alt="book" fallback={fallbackDiv()} />);

      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("does not show the placeholder when src is empty", () => {
      const { container } = render(
        <LazyCover src="" alt="book" fallback={fallbackDiv()} />,
      );

      expect(placeholderIn(container)).toBeNull();
    });
  });

  describe("loading state", () => {
    it("renders img with opacity-0 class and shows the placeholder while loading", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="測試書名"
          fallback={fallbackDiv()}
        />,
      );

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "https://example.com/cover.jpg");
      expect(img.className).toContain("opacity-0");

      const placeholder = placeholderIn(container);
      expect(placeholder).not.toBeNull();
      expect(placeholder).toBeEmptyDOMElement();
    });

    it("renders no animated element while loading (#430)", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          fallback={fallbackDiv()}
        />,
      );

      // Positive companion: the cover really is in "loading".
      expect(placeholderIn(container)).not.toBeNull();
      expect(animatedClassesIn(container)).toEqual([]);
    });

    it("sets loading='lazy' and decoding='async' on img", () => {
      render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
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
          fallback={fallbackDiv()}
        />,
      );

      expect(screen.getByAltText("測試書名")).toBeInTheDocument();
    });
  });

  describe("loaded state", () => {
    it("shows img with opacity-100 and removes the placeholder after load", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          fallback={fallbackDiv()}
        />,
      );
      expect(placeholderIn(container)).not.toBeNull();

      fireEvent.load(screen.getByRole("img"));

      expect(screen.getByRole("img").className).toContain("opacity-100");
      expect(placeholderIn(container)).toBeNull();
      expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("renders fallback and removes img on error", () => {
      render(
        <LazyCover
          src="https://example.com/broken.jpg"
          alt="book"
          fallback={fallbackDiv()}
        />,
      );

      fireEvent.error(screen.getByRole("img"));

      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });

  describe("className passthrough", () => {
    it("applies className to wrapper and img", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          className="w-10 h-14 rounded"
          fallback={fallbackDiv()}
        />,
      );

      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("w-10");

      const img = screen.getByRole("img");
      expect(img.className).toContain("w-10");
    });
  });
});
