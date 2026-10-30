import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LazyCover } from "@/dialog/LazyCover";

/**
 * LazyCover (Extension): the lazily loaded cover image, its loading placeholder, the fade-in on load
 * and the fallback on error / empty src.
 *
 * jsdom applies no stylesheet, so every visual state is probed through class names: the fade is the
 * `.moo-lazy-cover__img--loaded` modifier on the img (opacity → 1 in styles.css), and the loading
 * state is the `.moo-lazy-cover__placeholder` element, mounted only while status === "loading".
 *
 * Static placeholder (#430): the img is `loading="lazy"`, so an off-screen cover never fires `load`
 * and stays in "loading" for as long as the Dialog is open. The old loader was a spinning circle
 * (`.moo-lazy-cover__spinner` + `@keyframes moo-lazy-spin`), so every off-screen cover animated
 * forever. The placeholder is now a static grey box with no animation and no icon. Two checks pin it:
 * the rendered subtree carries no `__spinner` / `animate-` class while loading, and styles.css holds
 * no `moo-lazy-spin` keyframe and no `animation` inside any `.moo-lazy-cover__placeholder` rule. Each
 * negative check has a positive companion (the placeholder element exists; the placeholder rule is
 * found) so a renamed selector cannot let it pass vacuously.
 *
 * Reading styles.css: the Dialog imports it as `?raw`, which resolves to an EMPTY string under
 * Vitest (see tests/unit/dialog/onboardingStyles.test.ts), so the file is read from disk. The path
 * is resolved from `__dirname`, not `new URL("…", import.meta.url)`, which Vite rewrites into a
 * served asset URL (see tests/unit/prettierIgnore.test.ts → "Path resolution").
 */

const STYLES_PATH = resolve(__dirname, "../../src/dialog/styles.css");

/** The loading placeholder (rendered only while status === "loading"), if present. */
function placeholderIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".moo-lazy-cover__placeholder");
}

/** Class tokens in the subtree that mark an animated loader.
 *  See the header → "Static placeholder". */
function animatedClassesIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("*"))
    .flatMap((el) => Array.from(el.classList))
    .filter((name) => name.includes("__spinner") || name.includes("animate-"));
}

/** Body (selector to the next `}`) of every styles.css rule naming the placeholder class. */
function placeholderRuleBodies(css: string): string[] {
  const rule = /\.moo-lazy-cover__placeholder(?![\w-])[^{}]*\{([^}]*)\}/g;
  return Array.from(css.matchAll(rule), (match) => match[1]);
}

function fallbackDiv() {
  return <div data-testid="fallback">no cover</div>;
}

function renderLiveCover() {
  return render(
    <LazyCover
      src="https://example.com/cover.jpg"
      alt="book"
      width={40}
      height={60}
      fallback={fallbackDiv()}
    />,
  );
}

describe("LazyCover", () => {
  describe("empty src", () => {
    it("renders fallback directly when src is empty string", () => {
      render(
        <LazyCover
          src=""
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("does not show the placeholder when src is empty", () => {
      const { container } = render(
        <LazyCover
          src=""
          alt="book"
          width={40}
          height={60}
          fallback={fallbackDiv()}
        />,
      );

      // Empty src renders only the fallback — no wrapper, so no placeholder.
      expect(placeholderIn(container)).toBeNull();
    });
  });

  describe("loading state", () => {
    it("renders the not-yet-loaded img and shows the placeholder while loading", () => {
      // While loading the img has the base class WITHOUT `--loaded`.
      // See the header → jsdom applies no stylesheet.
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

      expect(placeholderIn(container)).not.toBeNull();
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
    it("adds the --loaded modifier to the img and removes the placeholder after load", () => {
      const { container } = renderLiveCover();

      fireEvent.load(screen.getByRole("img"));

      expect(screen.getByRole("img")).toHaveClass(
        "moo-lazy-cover__img--loaded",
      );
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

  describe("placeholder lifecycle", () => {
    it("renders the placeholder element while loading, hidden from assistive tech", () => {
      const { container } = renderLiveCover();

      const placeholder = placeholderIn(container);
      expect(placeholder).not.toBeNull();
      expect(placeholder).toHaveAttribute("aria-hidden", "true");
      expect(placeholder).toBeEmptyDOMElement();
    });

    it("removes the placeholder element once the image has loaded", () => {
      const { container } = renderLiveCover();
      expect(placeholderIn(container)).not.toBeNull();

      fireEvent.load(screen.getByRole("img"));

      expect(placeholderIn(container)).toBeNull();
    });
  });

  describe("static placeholder (#430)", () => {
    it("renders no animated loader element while loading", () => {
      const { container } = renderLiveCover();

      // Positive companion: the cover really is in "loading".
      expect(placeholderIn(container)).not.toBeNull();
      expect(animatedClassesIn(container)).toEqual([]);
    });

    it("keeps no spin keyframe in styles.css", () => {
      const css = readFileSync(STYLES_PATH, "utf8");

      // Positive companion: the stylesheet bytes were read.
      expect(css).toContain(".moo-lazy-cover__img");
      expect(css).not.toContain("moo-lazy-spin");
    });

    it("declares no animation in any placeholder rule of styles.css", () => {
      const bodies = placeholderRuleBodies(readFileSync(STYLES_PATH, "utf8"));

      // Positive companion: the base rule exists, so the negative is not vacuous.
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies[0]).toMatch(/position:\s*absolute/);
      for (const body of bodies) {
        expect(body).not.toMatch(/animation/);
      }
    });
  });
});
