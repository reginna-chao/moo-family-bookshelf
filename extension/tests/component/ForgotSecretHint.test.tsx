import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "../../src/constants";
import { ForgotSecretHint } from "@/dialog/ForgotSecretHint";

/**
 * ForgotSecretHint (Extension): the line beside every verification step that tells a user who
 * cannot pass it where to go. On the official server it links to the recovery request form; on a
 * self-hosted one it sends them to the server admin, with NO link — the official form cannot help a
 * self-hoster, and a self-hoster's user must never be routed to the project's form.
 *
 * The verdict comes from the ADOPTED endpoint (`apiClient.getEndpoint()` through
 * `classifyAdoptedEndpoint`), so the mock only needs `getEndpoint`. Copy and link are pinned as
 * literals ON PURPOSE: importing them from shared/ would compare production with itself.
 */

const QUESTION = "沒辦法完成驗證？";
const LINK_LABEL = "填寫救援申請";
const SELF_HOSTED = "忘記的話，請找伺服器管理者協助。";
const RECOVERY_URL = `https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?platform=googleform&topic=recovery&v=${__APP_VERSION__}`;

function clientOn(endpoint: string): ApiClient {
  return { getEndpoint: vi.fn(() => endpoint) } as unknown as ApiClient;
}

describe("ForgotSecretHint", () => {
  it("links to the recovery form on the official endpoint", () => {
    const { container } = render(
      <ForgotSecretHint apiClient={clientOn(DEFAULT_API_ENDPOINT)} />,
    );

    const link = screen.getByRole("link", { name: LINK_LABEL });
    expect(link).toHaveAttribute("href", RECOVERY_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")?.split(/\s+/)).toContain("noopener");
    expect(container.textContent).toBe(`${QUESTION}${LINK_LABEL}`);
    expect(screen.queryByText(SELF_HOSTED)).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "a self-hosted HTTPS server",
      endpoint: "https://nas.example.com/moo",
    },
    { name: "a plain-HTTP LAN server", endpoint: "http://192.168.1.10:8787" },
    // Defence in depth: setEndpoint validates, so this cannot normally be adopted.
    { name: "a refused address", endpoint: "https://real.example@evil.com" },
  ])("sends the user to the admin, with no link, on $name", ({ endpoint }) => {
    const { container } = render(
      <ForgotSecretHint apiClient={clientOn(endpoint)} />,
    );

    expect(container.textContent).toBe(SELF_HOSTED);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByText(new RegExp(LINK_LABEL))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(QUESTION))).not.toBeInTheDocument();
  });
});
