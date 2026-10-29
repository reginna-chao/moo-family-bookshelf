import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "../../src/constants";
import { ReauthModal } from "@/dialog/ReauthModal";
import type { UseVerificationPromptResult } from "@/dialog/useVerificationPrompt";

/**
 * ReauthModal: the re-verification modal over the main view. These cases pin the forgot-secret hint
 * it renders below the challenge — the recovery-form link on the official server, the "ask your
 * admin" line (no link) on a self-hosted one — and that the challenge itself stays intact beside it.
 * The endpoint disclosure above the challenge is covered in App.test.tsx (it needs the real client).
 *
 * `reauth` is a static `UseVerificationPromptResult` on a PIN account; the PIN field renders through
 * the SecureFrame stub from tests/setup.ts. Copy is pinned as literals (see ForgotSecretHint.test.tsx).
 */

const QUESTION = "沒辦法完成驗證？";
const LINK_LABEL = "填寫救援申請";
const SELF_HOSTED = "忘記的話，請找伺服器管理者協助。";
const RECOVERY_URL = `https://reginna-chao.github.io/moo-family-bookshelf/feedback.html?platform=googleform&topic=recovery&v=${__APP_VERSION__}`;

function pinChallenge(): UseVerificationPromptResult {
  return {
    active: true,
    method: "pin",
    methodError: false,
    error: "",
    locked: false,
    submitting: false,
    countdownSeconds: null,
    begin: vi.fn(),
    submit: vi.fn(),
    cancel: vi.fn(),
  };
}

function renderModal(endpoint: string) {
  const apiClient = {
    getEndpoint: vi.fn(() => endpoint),
  } as unknown as ApiClient;
  render(<ReauthModal apiClient={apiClient} reauth={pinChallenge()} />);
  return screen.getByRole("dialog", { name: "需要驗證" });
}

describe("ReauthModal", () => {
  it("offers the recovery form below the challenge on the official endpoint", () => {
    const modal = renderModal(DEFAULT_API_ENDPOINT);

    const link = within(modal).getByRole("link", { name: LINK_LABEL });
    expect(link).toHaveAttribute("href", RECOVERY_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.closest("p")?.textContent).toBe(`${QUESTION}${LINK_LABEL}`);
    expect(within(modal).queryByText(SELF_HOSTED)).not.toBeInTheDocument();
  });

  it("points a self-hosted user at the admin, with no link", () => {
    const modal = renderModal("https://nas.example.com/moo");

    expect(within(modal).getByText(SELF_HOSTED)).toBeInTheDocument();
    expect(within(modal).queryByRole("link")).not.toBeInTheDocument();
    expect(
      within(modal).queryByText(new RegExp(LINK_LABEL)),
    ).not.toBeInTheDocument();
  });

  it("keeps the challenge on screen, with the hint after it", () => {
    const modal = renderModal(DEFAULT_API_ENDPOINT);

    const back = within(modal).getByRole("button", { name: "返回" });
    expect(within(modal).getByText("請輸入 PIN 碼")).toBeInTheDocument();
    const hint = within(modal).getByRole("link", { name: LINK_LABEL });
    expect(
      back.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
