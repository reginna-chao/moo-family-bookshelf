import { describe, it, expect } from "vitest";
import { reportLinks } from "moo-family-bookshelf-shared/config/links";

describe("reportLinks", () => {
  it("has exactly 2 entries", () => {
    expect(reportLinks).toHaveLength(2);
  });

  it("GitHub entry is a direct link to the repository", () => {
    const github = reportLinks.find((l) => l.name === "GitHub");
    expect(github).toBeDefined();
    expect(github!.url).toBe(
      "https://github.com/reginna-chao/moo-family-bookshelf",
    );
  });

  it("Plurk entry points to the feedback redirect page, not directly to plurk.com", () => {
    const plurk = reportLinks.find((l) => l.name === "Plurk");
    expect(plurk).toBeDefined();
    expect(plurk!.url).toBe(
      "https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?platform=plurk",
    );
  });
});
