import { describe, it, expect } from "vitest";
import { getReportLinks } from "moo-family-bookshelf-shared/config/links";

const TEST_VERSION = "1.2.3";

describe("getReportLinks", () => {
  it("returns three entries", () => {
    expect(getReportLinks({ appVersion: TEST_VERSION })).toHaveLength(3);
  });

  it("orders GoogleForm first, then GitHub, then Plurk", () => {
    const links = getReportLinks({ appVersion: TEST_VERSION });
    expect(links.map((l) => l.name)).toEqual(["GoogleForm", "GitHub", "Plurk"]);
  });

  it("GoogleForm entry points to feedback redirect with platform and version query", () => {
    const link = getReportLinks({ appVersion: TEST_VERSION }).find(
      (l) => l.name === "GoogleForm",
    );
    expect(link).toBeDefined();
    expect(
      link!.url.startsWith(
        "https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?",
      ),
    ).toBe(true);
    expect(link!.url).toContain("platform=googleform");
    expect(link!.url).toContain("v=1.2.3");
  });

  it("GitHub entry is a direct link to the repository", () => {
    const link = getReportLinks({ appVersion: TEST_VERSION }).find(
      (l) => l.name === "GitHub",
    );
    expect(link).toBeDefined();
    expect(link!.url).toBe(
      "https://github.com/reginna-chao/moo-family-bookshelf",
    );
  });

  it("Plurk entry points to the feedback redirect page", () => {
    const link = getReportLinks({ appVersion: TEST_VERSION }).find(
      (l) => l.name === "Plurk",
    );
    expect(link).toBeDefined();
    expect(link!.url).toBe(
      "https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?platform=plurk",
    );
  });

  it("every entry has a non-empty svgPath", () => {
    const links = getReportLinks({ appVersion: TEST_VERSION });
    expect(links.every((l) => l.svgPath.length > 0)).toBe(true);
  });
});
