import type { ReactNode } from "react";
import { vi, type Mock } from "vitest";
import type { ApiClient, ApiResponse } from "@/api/client";
import type {
  AccountSettings,
  AccountSettingsApi,
  AccountSettingsPatch,
} from "moo-family-bookshelf-shared/api/accountSettings";
import { AccountSettingsProvider } from "@/dialog/AccountSettingsContext";

/** The endpoint `createAccountSettingsServer`'s client reports until `setEndpoint` moves it. */
export const ACCOUNT_SETTINGS_TEST_ENDPOINT = "https://api.example.test";

type GetSettings = (userId: string) => Promise<ApiResponse<AccountSettings>>;
type PatchSettings = (
  userId: string,
  patch: AccountSettingsPatch,
) => Promise<ApiResponse<AccountSettings>>;

export interface FakeAccountSettingsServer {
  /** An `ApiClient` stand-in carrying only `getEndpoint` and `accountSettings`. */
  client: ApiClient;
  /** The `accountSettings` field alone, to spread into a fuller mock client. */
  api: AccountSettingsApi;
  /** The server's record; mutable, so a case can change what the next GET returns. */
  record: AccountSettings;
  get: Mock<GetSettings>;
  patch: Mock<PatchSettings>;
  /** Move what `client.getEndpoint()` reports (a server switch mid-request). */
  setEndpoint: (url: string) => void;
}

/**
 * An in-memory account-settings server (#460) behind an `ApiClient`-shaped
 * stand-in. GET returns a copy of `record`; PATCH applies the contract of
 * `PATCH /api/user/:id/settings` — `ifAbsent` fills only absent fields, then
 * `settings` overwrites — and returns the merged record. Override `get` /
 * `patch` per case (`mockResolvedValueOnce`, a held promise) for errors and
 * interleavings; the default implementations stay behind them.
 */
export function createAccountSettingsServer(
  initial: AccountSettings = {},
): FakeAccountSettingsServer {
  const record: AccountSettings = { ...initial };
  let endpoint = ACCOUNT_SETTINGS_TEST_ENDPOINT;
  const get = vi.fn<GetSettings>(async () => ({ data: { ...record } }));
  const patch = vi.fn<PatchSettings>(async (_userId, body) => {
    const filled = record as Record<string, unknown>;
    for (const [field, value] of Object.entries(body.ifAbsent ?? {})) {
      if (filled[field] === undefined) filled[field] = value;
    }
    Object.assign(record, body.settings ?? {});
    return { data: { ...record } };
  });
  const api: AccountSettingsApi = { get, patch };
  const client = {
    getEndpoint: () => endpoint,
    accountSettings: api,
  } as unknown as ApiClient;
  return {
    client,
    api,
    record,
    get,
    patch,
    setEndpoint: (url) => {
      endpoint = url;
    },
  };
}

/** A `renderHook` wrapper mounting the real `AccountSettingsProvider` for `client` and `userId`. */
export function accountSettingsWrapper(client: ApiClient, userId: string) {
  return function AccountSettingsTestWrapper({
    children,
  }: {
    children: ReactNode;
  }) {
    return (
      <AccountSettingsProvider apiClient={client} userId={userId}>
        {children}
      </AccountSettingsProvider>
    );
  };
}
