import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  queryWithLegacyFallback,
  resetScrapeWarnings,
} from "@/content/readmoo-dom";

const PRIMARY = ".openbook-overlay .detail";
const LEGACY = ".openbook .detail";
const LABEL = "test:detail";

/** Build a detached card carrying the new-site markup, the legacy one, or both. */
function buildCard(shape: "next" | "legacy" | "both" | "neither"): HTMLElement {
  const card = document.createElement("div");
  const nextMarkup = `<div class="openbook-overlay"><div class="detail" data-site="next"></div></div>`;
  const legacyMarkup = `<div class="openbook"><div class="detail" data-site="legacy"></div></div>`;
  const markupBySite = {
    next: nextMarkup,
    legacy: legacyMarkup,
    both: `${nextMarkup}${legacyMarkup}`,
    neither: "<div></div>",
  };
  card.innerHTML = markupBySite[shape];
  document.body.appendChild(card);
  return card;
}

describe("queryWithLegacyFallback", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The de-duplication set lives at module scope — reset it before AND after
    // every case so warning assertions never depend on execution order.
    resetScrapeWarnings();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetScrapeWarnings();
    document.body.innerHTML = "";
  });

  it("returns the primary match without warning", () => {
    const card = buildCard("next");

    const found = queryWithLegacyFallback<HTMLElement>(
      card,
      PRIMARY,
      LEGACY,
      LABEL,
    );

    expect(found?.dataset.site).toBe("next");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("prefers the primary match when both markups are present", () => {
    const card = buildCard("both");

    const found = queryWithLegacyFallback<HTMLElement>(
      card,
      PRIMARY,
      LEGACY,
      LABEL,
    );

    expect(found?.dataset.site).toBe("next");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns the legacy match and warns once when the primary misses", () => {
    const card = buildCard("legacy");

    const found = queryWithLegacyFallback<HTMLElement>(
      card,
      PRIMARY,
      LEGACY,
      LABEL,
    );

    expect(found?.dataset.site).toBe("legacy");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[moo] legacy selector fallback hit for "${LABEL}": "${PRIMARY}" not found, used "${LEGACY}"`,
    );
  });

  it("warns only once per label even when many cards hit the legacy path", () => {
    const cards = [
      buildCard("legacy"),
      buildCard("legacy"),
      buildCard("legacy"),
    ];

    for (const card of cards) {
      const found = queryWithLegacyFallback<HTMLElement>(
        card,
        PRIMARY,
        LEGACY,
        LABEL,
      );
      expect(found?.dataset.site).toBe("legacy");
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns separately for each distinct label", () => {
    const card = buildCard("legacy");

    queryWithLegacyFallback<HTMLElement>(card, PRIMARY, LEGACY, "label-a");
    queryWithLegacyFallback<HTMLElement>(card, PRIMARY, LEGACY, "label-b");

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain('"label-a"');
    expect(warnSpy.mock.calls[1][0]).toContain('"label-b"');
  });

  it("warns again for the same label after resetScrapeWarnings", () => {
    const card = buildCard("legacy");

    queryWithLegacyFallback<HTMLElement>(card, PRIMARY, LEGACY, LABEL);
    resetScrapeWarnings();
    queryWithLegacyFallback<HTMLElement>(card, PRIMARY, LEGACY, LABEL);

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null without warning when neither selector matches", () => {
    const card = buildCard("neither");

    const found = queryWithLegacyFallback<HTMLElement>(
      card,
      PRIMARY,
      LEGACY,
      LABEL,
    );

    expect(found).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("scopes the query to the given root, not the whole document", () => {
    buildCard("next");
    const otherCard = buildCard("neither");

    const found = queryWithLegacyFallback<HTMLElement>(
      otherCard,
      PRIMARY,
      LEGACY,
      LABEL,
    );

    expect(found).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
