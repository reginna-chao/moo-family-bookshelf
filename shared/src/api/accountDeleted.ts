import type { ApiResponse } from "./types";

export const ACCOUNT_DELETED_ERROR_CODE = "ACCOUNT_DELETED";

/** The account was already deleted by an earlier request whose response was lost: this delete succeeded. */
export function treatAccountDeletedAsSuccess(
  res: ApiResponse<{ ok: boolean }>,
): ApiResponse<{ ok: boolean }> {
  return res.error?.code === ACCOUNT_DELETED_ERROR_CODE
    ? { data: { ok: true } }
    : res;
}
