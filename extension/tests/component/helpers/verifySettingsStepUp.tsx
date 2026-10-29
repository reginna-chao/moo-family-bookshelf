import { vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { VerificationSettings } from "@/dialog/VerificationSettings";

/**
 * Mount `VerificationSettings` with `getVerifyMethod` answering `methods` in order (the last one
 * repeats) and the given `setVerifyMethod`. `act` is the ready barrier: the load effect has committed
 * on return, so the method buttons are interactive.
 */
export async function renderVerifySettings(
  methods: VerifyMethod[],
  setVerifyMethod: ReturnType<typeof vi.fn>,
) {
  const queue = [...methods];
  const getVerifyMethod = vi.fn(async () => ({
    data: { method: queue.length > 1 ? queue.shift() : queue[0] },
  }));
  const api = {
    getVerifyMethod,
    setVerifyMethod,
    generateOtp: vi.fn(),
    getEndpoint: vi.fn(() => DEFAULT_API_ENDPOINT),
  } as unknown as ApiClient;
  await act(async () => {
    render(<VerificationSettings userId="user-1" apiClient={api} />);
  });
  return { getVerifyMethod, setVerifyMethod };
}

/** Click a method button; `act` flushes a save it may start straight away. */
export async function pickMethod(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
  });
}

/** Type `pin` into the (single) PIN field and press its 確認; `act` flushes any save it triggers. */
export async function submitPin(pin: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
    target: { value: pin },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "確認" }));
  });
}

/** The body of `setVerifyMethod`'s call number `index` (0-based). */
export function putBody(
  setVerifyMethod: ReturnType<typeof vi.fn>,
  index = 0,
): unknown {
  return setVerifyMethod.mock.calls[index]?.[1];
}
