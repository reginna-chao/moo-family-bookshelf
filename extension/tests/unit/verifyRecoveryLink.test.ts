import { describe, it, expect } from "vitest";
import {
  getReportLinks,
  getVerifyRecoveryLink,
} from "moo-family-bookshelf-shared/config/links";

/**
 * getVerifyRecoveryLink: the forgot-secret hint's link (official server only) to the feedback
 * redirect page, which forwards to the Google Form with the recovery topic prefilled. The page and
 * the three query parameters are pinned as literals: `site/feedback.html` reads `platform`, `topic`
 * and `v` by name, so a renamed parameter would silently lose the prefill.
 *
 * `getReportLinks` must be untouched by the addition: its GoogleForm entry carries no `topic`, so an
 * ordinary report never lands in the recovery queue.
 */

const FEEDBACK_PAGE =
  "https://reginna-chao.github.io/moo-family-bookshelf/feedback.html";

describe("getVerifyRecoveryLink", () => {
  it("builds the feedback page URL with platform, topic and version in that order", () => {
    expect(getVerifyRecoveryLink({ appVersion: "1.2.3" })).toBe(
      `${FEEDBACK_PAGE}?platform=googleform&topic=recovery&v=1.2.3`,
    );
  });

  it.each([
    { appVersion: "1.2.3" },
    { appVersion: "2.0.0-beta.1" },
    // Reserved characters must be encoded, not split into a fourth parameter.
    { appVersion: "1.0 rc+1&x=y" },
  ])(
    "round-trips version $appVersion through the query string",
    ({ appVersion }) => {
      const url = new URL(getVerifyRecoveryLink({ appVersion }));

      expect(`${url.origin}${url.pathname}`).toBe(FEEDBACK_PAGE);
      expect([...url.searchParams.keys()]).toEqual(["platform", "topic", "v"]);
      expect(url.searchParams.get("platform")).toBe("googleform");
      expect(url.searchParams.get("topic")).toBe("recovery");
      expect(url.searchParams.get("v")).toBe(appVersion);
    },
  );
});

describe("getReportLinks alongside the recovery link", () => {
  it("keeps the GoogleForm report entry free of the recovery topic", () => {
    const link = getReportLinks({ appVersion: "1.2.3" }).find(
      (l) => l.name === "GoogleForm",
    );
    expect(link).toBeDefined();
    const url = new URL(link!.url);

    expect(`${url.origin}${url.pathname}`).toBe(FEEDBACK_PAGE);
    expect(url.searchParams.get("platform")).toBe("googleform");
    expect(url.searchParams.has("topic")).toBe(false);
  });
});
