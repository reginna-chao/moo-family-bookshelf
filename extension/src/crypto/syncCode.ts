/** Sync code encode/decode: `moo-{familyId}` (default API) or `moo-{familyId}@{host}` (custom API
 *  endpoint). See docs/architecture.md → 四、同步碼設計. */

import {
  classifySyncCodeApiHost,
  type SyncCodeApiHostResult,
} from "moo-family-bookshelf-shared/api/syncCodeHost";

export type { SyncCodeApiHostResult };

export interface SyncCodeData {
  familyId: string;
  apiHost?: string;
}

const SYNC_CODE_PREFIX = "moo";

export function encodeSyncCode(data: SyncCodeData): string {
  const base = `${SYNC_CODE_PREFIX}-${data.familyId}`;
  if (data.apiHost) {
    return `${base}@${data.apiHost}`;
  }
  return base;
}

export function decodeSyncCode(code: string): SyncCodeData {
  const trimmed = code.trim();

  // Split off @host if present
  let main: string;
  let apiHost: string | undefined;

  const atIndex = trimmed.indexOf("@");
  if (atIndex !== -1) {
    main = trimmed.slice(0, atIndex);
    apiHost = trimmed.slice(atIndex + 1);
    if (!apiHost) {
      throw new SyncCodeError("API host is empty after @");
    }
  } else {
    main = trimmed;
  }

  // moo-{xxxx}-{xxxx}: familyId has its own dash, so parse positionally (prefix = parts[0], familyId =
  // parts[1]-parts[2]); the old format's parts[3..] encryptionKey is ignored (backward compat).
  const parts = main.split("-");
  if (parts.length < 3) {
    throw new SyncCodeError(
      "Invalid sync code format: expected moo-{familyId}",
    );
  }

  const prefix = parts[0];
  const familyId = `${parts[1]}-${parts[2]}`;

  if (prefix !== SYNC_CODE_PREFIX) {
    throw new SyncCodeError("Invalid sync code format");
  }

  if (!parts[1] || !parts[2]) {
    throw new SyncCodeError("Family ID is empty");
  }

  return { familyId, apiHost };
}

/**
 * Best-effort inspection of the `@host` segment for DISPLAY purposes (telling
 * the user which server a pasted sync code will connect to before they join).
 *
 * Never throws: partial / malformed input while the user is still typing yields
 * `{ kind: "none" }`. Use `decodeSyncCode` when the failure matters. The
 * verdict itself comes from the shared classifier, which runs the same
 * validation the join path adopts — so the note reflects what would actually be
 * adopted, not the raw string, and cannot drift from the PWA's note.
 */
export function parseSyncCodeApiHost(code: string): SyncCodeApiHostResult {
  let apiHost: string | undefined;
  try {
    apiHost = decodeSyncCode(code).apiHost;
  } catch {
    return { kind: "none" };
  }
  return classifySyncCodeApiHost(apiHost);
}

export class SyncCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCodeError";
  }
}
