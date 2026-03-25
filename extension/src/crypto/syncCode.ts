/**
 * Sync code encode/decode.
 *
 * Format:
 *   moo-{familyId}-{encryptionKey}          (default API)
 *   moo-{familyId}-{encryptionKey}@{host}   (custom API endpoint)
 */

export interface SyncCodeData {
  familyId: string;
  encryptionKey: string;
  apiHost?: string;
}

const SYNC_CODE_PREFIX = "moo";

export function encodeSyncCode(data: SyncCodeData): string {
  const base = `${SYNC_CODE_PREFIX}-${data.familyId}-${data.encryptionKey}`;
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

  const parts = main.split("-");
  if (parts.length < 3) {
    throw new SyncCodeError(
      "Invalid sync code format: expected moo-{familyId}-{key}",
    );
  }

  const [prefix, familyId, ...keyParts] = parts;
  const encryptionKey = keyParts.join("-");

  if (prefix !== SYNC_CODE_PREFIX) {
    throw new SyncCodeError(
      `Invalid sync code prefix: expected "${SYNC_CODE_PREFIX}", got "${prefix}"`,
    );
  }

  if (!familyId) {
    throw new SyncCodeError("Family ID is empty");
  }

  if (!encryptionKey) {
    throw new SyncCodeError("Encryption key is empty");
  }

  return { familyId, encryptionKey, apiHost };
}

export class SyncCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCodeError";
  }
}
