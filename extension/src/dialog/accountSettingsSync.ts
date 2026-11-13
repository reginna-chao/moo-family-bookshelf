/** Per-Dialog-open controller of the account settings (#460): the open-time refresh and each save,
 *  sharing one PATCH queue. Rules: docs/architecture.md → 本機儲存與同步. */

import type { ApiClient, ApiResponse } from "../api/client";
import type {
  AccountSettings,
  AccountSettingsField,
  AccountSettingsPatch,
} from "moo-family-bookshelf-shared/api/accountSettings";
import {
  readStoredAccountSettings,
  writeFollowedAccountSettings,
  writeLocalAccountSetting,
} from "../storage/accountSettings";
import {
  clearPendingAccountSettings,
  readPendingAccountSettings,
} from "../storage/accountSettingsPending";
import {
  runAccountSettingsRefresh,
  type AccountSettingsRefreshHost,
  type AccountSettingsRefreshOutcome,
} from "./accountSettingsRefresh";
import { SerialPatchQueue } from "./accountSettingsPatchQueue";

export type { AccountSettingsRefreshOutcome };
export { ACCOUNT_SETTINGS_WRITE_GAP_MS } from "./accountSettingsPatchQueue";
export type AccountSettingsSaveOutcome =
  "saved" | "localOnly" | "failed" | "stale";

type AccountSettingsClient = Pick<ApiClient, "accountSettings" | "getEndpoint">;
type PatchReply = ApiResponse<AccountSettings> | null;

/** One per Dialog open (`AccountSettingsProvider`); `refresh` / `save` never reject (any error is `failed`).
 *  storage.local is written only once the server confirmed a value, or in local-only mode (a 404). */
export class AccountSettingsSync {
  private readonly api: AccountSettingsClient;
  private readonly userId: string;
  private refreshing: Promise<AccountSettingsRefreshOutcome> | null = null;
  private unsupported = false;
  private disposed = false;
  private readonly saving = new Map<AccountSettingsField, number>();
  private readonly listeners = new Set<() => void>();
  private readonly settleWaiters = new Set<() => void>();
  private readonly patches = new SerialPatchQueue();

  constructor(api: AccountSettingsClient, userId: string) {
    this.api = api;
    this.userId = userId;
  }

  /** Runs once per instance; a repeated call returns the same promise. */
  refresh(): Promise<AccountSettingsRefreshOutcome> {
    this.refreshing ??= this.runRefresh();
    return this.refreshing;
  }

  /** Save one setting: `saved` once the server confirmed it, `localOnly` on a server without the feature. */
  async save<K extends AccountSettingsField>(
    field: K,
    next: NonNullable<AccountSettings[K]>,
  ): Promise<AccountSettingsSaveOutcome> {
    this.saving.set(field, (this.saving.get(field) ?? 0) + 1);
    try {
      return await this.runSave(field, next);
    } catch (err) {
      console.warn("[accountSettingsSync] save failed", err);
      return "failed";
    } finally {
      const left = (this.saving.get(field) ?? 1) - 1;
      if (left > 0) this.saving.set(field, left);
      else this.saving.delete(field);
    }
  }

  /** Resolves once `refresh` settles or after `timeoutMs`, whichever is first. Never rejects. */
  whenSettled(timeoutMs: number): Promise<void> {
    const refreshing = this.refreshing;
    if (refreshing === null || this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.settleWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.settleWaiters.add(finish);
      void refreshing.then(finish);
    });
  }

  isUnsupported(): boolean {
    return this.unsupported;
  }

  /** For `useSyncExternalStore`: `listener` runs when the server turns out not to support this. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stop: nothing more is sent or written, and every pending timer is cleared. */
  dispose(): void {
    this.disposed = true;
    this.patches.close();
    for (const finish of [...this.settleWaiters]) finish();
    this.listeners.clear();
  }

  private async runRefresh(): Promise<AccountSettingsRefreshOutcome> {
    try {
      return await runAccountSettingsRefresh(this.refreshHost());
    } catch (err) {
      console.warn("[accountSettingsSync] refresh failed", err);
      return "failed";
    }
  }

  private refreshHost(): AccountSettingsRefreshHost {
    return {
      api: this.api,
      userId: this.userId,
      isStale: (server) => this.isStale(server),
      isSaving: (field) => this.saving.has(field),
      markUnsupported: () => this.markUnsupported(),
      sendPatch: (patch) => this.sendPatch(patch),
    };
  }

  private async runSave<K extends AccountSettingsField>(
    field: K,
    next: NonNullable<AccountSettings[K]>,
  ): Promise<AccountSettingsSaveOutcome> {
    if (this.disposed) return "stale";
    if (this.unsupported) {
      await writeLocalAccountSetting(field, next);
      return "localOnly";
    }
    const server = this.api.getEndpoint();
    const sent = { [field]: next } as AccountSettings;
    const before = (await readStoredAccountSettings())[field];
    const pendingBefore = (await readPendingAccountSettings(this.userId))[
      field
    ];
    const res = await this.sendPatch({ settings: sent });
    if (res === null || this.isStale(server)) return "stale";
    if (res.error?.code === "NOT_FOUND") {
      this.markUnsupported();
      await writeLocalAccountSetting(field, next);
      return "localOnly";
    }
    if (res.error || res.data === undefined) return "failed";
    // Cache the confirmed value unless another tab or the options page wrote this field meanwhile.
    if ((await readStoredAccountSettings())[field] === before) {
      const saved = res.data[field] ?? next;
      await writeFollowedAccountSettings(this.userId, {
        [field]: saved,
      } as AccountSettings);
    }
    await clearPendingAccountSettings(this.userId, sent);
    // The Dialog's save supersedes a marker value that was already there when it started.
    if (pendingBefore !== undefined && pendingBefore !== next) {
      await clearPendingAccountSettings(this.userId, {
        [field]: pendingBefore,
      } as AccountSettings);
    }
    return "saved";
  }

  /** Every PATCH of this controller goes through one queue (`SerialPatchQueue`). */
  private sendPatch(patch: AccountSettingsPatch): Promise<PatchReply> {
    return this.patches.enqueue(() =>
      this.api.accountSettings.patch(this.userId, patch),
    );
  }

  private isStale(server: string): boolean {
    return this.disposed || this.api.getEndpoint() !== server;
  }

  private markUnsupported(): void {
    if (this.unsupported) return;
    this.unsupported = true;
    for (const listener of [...this.listeners]) listener();
  }
}
