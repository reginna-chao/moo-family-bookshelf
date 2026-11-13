/** The steps of `AccountSettingsSync.refresh()` (#460), split out of `accountSettingsSync.ts` for the
 *  line cap. Rules: docs/architecture.md → 本機儲存與同步. */

import type { ApiClient, ApiResponse } from "../api/client";
import type {
  AccountSettings,
  AccountSettingsField,
  AccountSettingsPatch,
} from "moo-family-bookshelf-shared/api/accountSettings";
import {
  readStoredAccountSettings,
  writeFollowedAccountSettings,
} from "../storage/accountSettings";
import {
  clearPendingAccountSettings,
  readPendingAccountSettings,
} from "../storage/accountSettingsPending";

export type AccountSettingsRefreshOutcome =
  "followed" | "unsupported" | "failed" | "stale";

/** What a refresh needs from the controller that runs it. */
export interface AccountSettingsRefreshHost {
  api: Pick<ApiClient, "accountSettings" | "getEndpoint">;
  userId: string;
  /** The controller was disposed, or the client moved off `server`. */
  isStale(server: string): boolean;
  /** The controller is saving `field` right now. */
  isSaving(field: AccountSettingsField): boolean;
  markUnsupported(): void;
  /** Send through the controller's PATCH queue; `null`, nothing sent, when stale on `server` before its turn. */
  sendPatch(
    patch: AccountSettingsPatch,
    server: string,
  ): Promise<ApiResponse<AccountSettings> | null>;
}

type FieldTest = (field: AccountSettingsField) => boolean;

/** The fields of a validated record (present values only) that pass `keep`. */
function pick(settings: AccountSettings, keep: FieldTest): AccountSettings {
  const kept = Object.entries(settings).filter(([field]) =>
    keep(field as AccountSettingsField),
  );
  return Object.fromEntries(kept) as AccountSettings;
}

function isEmpty(settings: AccountSettings): boolean {
  return Object.keys(settings).length === 0;
}

/** A protected field is one this controller is saving, or whose stored value moved off `snapshot`
 *  (another tab or the options page wrote it); a refresh never uploads or follows it. */
async function readProtection(
  host: AccountSettingsRefreshHost,
  snapshot: AccountSettings,
): Promise<FieldTest> {
  const current = await readStoredAccountSettings();
  return (field) => host.isSaving(field) || current[field] !== snapshot[field];
}

/** 404 = a server that predates account settings: settings stay local, the marker can never upload. */
async function settleGetError(
  host: AccountSettingsRefreshHost,
  code: string,
): Promise<AccountSettingsRefreshOutcome> {
  if (code !== "NOT_FOUND") return "failed";
  host.markUnsupported();
  const pending = await readPendingAccountSettings(host.userId);
  await clearPendingAccountSettings(host.userId, pending);
  return "unsupported";
}

type UploadResult = AccountSettings | null | "failed" | "stale";

/** One PATCH at most: pending values overwrite (`settings`), never-uploaded local ones fill
 *  (`ifAbsent`). Resolves to the merged server record, `null` when there was nothing to send. */
async function uploadLocal(
  host: AccountSettingsRefreshHost,
  server: string,
  resend: AccountSettings,
  fill: AccountSettings,
): Promise<UploadResult> {
  if (isEmpty(resend) && isEmpty(fill)) return null;
  const patch: AccountSettingsPatch = {
    ...(!isEmpty(resend) && { settings: resend }),
    ...(!isEmpty(fill) && { ifAbsent: fill }),
  };
  const res = await host.sendPatch(patch, server);
  if (res === null || host.isStale(server)) return "stale";
  if (res.error || res.data === undefined) return "failed";
  await clearPendingAccountSettings(host.userId, resend);
  return res.data;
}

/**
 * The open-time refresh: read the server record, upload what this browser
 * owes it, then cache the server's values locally. Resolves to `stale`
 * (writing nothing) once the controller is disposed or the client moved to
 * another server. A failed upload still follows the server for every field
 * outside the pending marker and resolves to `followed`; the marker stays for
 * the next open. May reject; the controller turns a rejection into `failed`.
 */
export async function runAccountSettingsRefresh(
  host: AccountSettingsRefreshHost,
): Promise<AccountSettingsRefreshOutcome> {
  // Captured before the first await, so a switch made while the GET is out is seen.
  const server = host.api.getEndpoint();
  const snapshot = await readStoredAccountSettings();
  if (host.isStale(server)) return "stale";
  const res = await host.api.accountSettings.get(host.userId);
  if (host.isStale(server)) return "stale";
  if (res.error) return settleGetError(host, res.error.code);
  const fromServer = res.data ?? {};

  // Re-read the marker here: a save may have cleared it, or the options page rewritten it, since the GET left.
  const isProtected = await readProtection(host, snapshot);
  const pending = await readPendingAccountSettings(host.userId);
  const resend = pick(pending, (field) => !isProtected(field));
  const fill = pick(
    snapshot,
    (field) =>
      fromServer[field] === undefined &&
      pending[field] === undefined &&
      !isProtected(field),
  );
  const uploaded = await uploadLocal(host, server, resend, fill);
  if (uploaded === "stale") return "stale";

  // A failed upload keeps the marker, and its fields keep their local value until the next open.
  const record =
    uploaded === "failed"
      ? pick(fromServer, (field) => pending[field] === undefined)
      : (uploaded ?? fromServer);
  const stillProtected = await readProtection(host, snapshot);
  const follow = pick(record, (field) => !stillProtected(field));
  if (host.isStale(server)) return "stale";
  if (!isEmpty(follow)) await writeFollowedAccountSettings(host.userId, follow);
  return "followed";
}
