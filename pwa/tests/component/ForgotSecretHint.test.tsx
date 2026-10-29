import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { ForgotSecretHint } from "@/components/ForgotSecretHint";

/**
 * ForgotSecretHint (PWA twin of the Extension's): on the official server it links to the recovery
 * request form; on a self-hosted one it sends the user to the server admin, with NO link. Unlike the
 * Extension's, the verdict arrives as the `official` prop — each caller derives it (the login screen
 * from the sync code's `@host`, VerifySetupPrompt from the client's endpoint), and those callers are
 * covered in LandingPage.test.tsx and VerifySetupPrompt.test.tsx.
 *
 * Copy and link are pinned as literals ON PURPOSE: importing them from shared/ would compare
 * production with itself.
 */

const QUESTION = "沒辦法完成驗證？";
const LINK_LABEL = "填寫救援申請";
const SELF_HOSTED = "忘記的話，請找伺服器管理者協助。";
const RECOVERY_URL = `https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?platform=googleform&topic=recovery&v=${__APP_VERSION__}`;

describe("ForgotSecretHint", () => {
  it("links to the recovery form when official", () => {
    const { container } = render(<ForgotSecretHint official />);

    const link = screen.getByRole("link", { name: LINK_LABEL });
    expect(link).toHaveAttribute("href", RECOVERY_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")?.split(/\s+/)).toContain("noopener");
    expect(container.textContent).toBe(`${QUESTION}${LINK_LABEL}`);
    expect(screen.queryByText(SELF_HOSTED)).not.toBeInTheDocument();
  });

  it("sends the user to the admin, with no link, when self-hosted", () => {
    const { container } = render(<ForgotSecretHint official={false} />);

    expect(container.textContent).toBe(SELF_HOSTED);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByText(new RegExp(LINK_LABEL))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(QUESTION))).not.toBeInTheDocument();
  });
});
