import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { LazyCover } from "@/components/LazyCover";

function fallbackDiv() {
  return <div data-testid="fallback">no cover</div>;
}

describe("LazyCover", () => {
  describe("empty src", () => {
    it("renders fallback directly when src is empty string", () => {
      render(
        <LazyCover src="" alt="book" fallback={fallbackDiv()} />,
      );

      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("does not show spinner when src is empty", () => {
      const { container } = render(
        <LazyCover src="" alt="book" fallback={fallbackDiv()} />,
      );

      expect(container.querySelector(".animate-spin")).toBeNull();
    });
  });

  describe("loading state", () => {
    it("renders img with opacity-0 class and shows spinner while loading", () => {
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

      expect(container.querySelector(".animate-spin")).not.toBeNull();
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
    it("shows img with opacity-100 and removes spinner after load", () => {
      const { container } = render(
        <LazyCover
          src="https://example.com/cover.jpg"
          alt="book"
          fallback={fallbackDiv()}
        />,
      );

      fireEvent.load(screen.getByRole("img"));

      expect(screen.getByRole("img").className).toContain("opacity-100");
      expect(container.querySelector(".animate-spin")).toBeNull();
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
