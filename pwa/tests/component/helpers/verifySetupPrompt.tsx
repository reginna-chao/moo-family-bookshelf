import { vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { VerifySetupPrompt } from "@/components/VerifySetupPrompt";
import { DEFAULT_API_ENDPOINT } from "@/constants";

// Shared by the VerifySetupPrompt step-up suites (#396); see each export's JSDoc.

export const PROMPT_USER_ID = "a".repeat(64);

/**
 * Mock client for a `prompted: 0` account whose `GET /verify` answers `method`. Every call the
 * prompt makes is a `vi.fn` the caller can override; `getVerifyMethod` answers `method` on every read
 * unless overridden (the step-up recovery re-reads it once).
 */
export function createPromptClient(
  method: VerifyMethod,
  overrides: Record<string, unknown> = {},
) {
  const client = {
    getVerifyPrompted: vi.fn().mockResolvedValue({ data: { prompted: 0 } }),
    getVerifyMethod: vi.fn().mockResolvedValue({ data: { method } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { method } }),
    markVerifyPrompted: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getEndpoint: vi.fn(() => DEFAULT_API_ENDPOINT),
    ...overrides,
  };
  return client as typeof client & ApiClient;
}

/**
 * Render the prompt and let both mount reads settle inside `act`: "loading" renders nothing, so
 * an assertion made before the reads resolve would pass vacuously.
 */
export async function renderPromptSettled(
  client: ApiClient,
  onComplete: () => void,
) {
  await act(async () => {
    render(
      <VerifySetupPrompt
        userId={PROMPT_USER_ID}
        apiClient={client}
        onComplete={onComplete}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Click inside `act`, so a save (and the re-read after a refused one) settles before returning. */
export async function clickAndSettle(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Type `pin` into the PIN field on screen and press 確認 once (a verify-mode entry submits). */
export async function enterPin(pin: string) {
  fireEvent.change(screen.getByLabelText("PIN 輸入"), {
    target: { value: pin },
  });
  await clickAndSettle(screen.getByRole("button", { name: "確認" }));
}

/** Set up `pin` on the setup-mode PIN entry: first entry, then the confirm entry that submits. */
export async function setUpPin(pin: string) {
  await enterPin(pin);
  await enterPin(pin);
}
