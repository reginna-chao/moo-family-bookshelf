import { describe, it, expect } from "vitest";
import {
  ACCOUNT_DELETED_ERROR_CODE,
  treatAccountDeletedAsSuccess,
} from "moo-family-bookshelf-shared/api/accountDeleted";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";

/**
 * treatAccountDeletedAsSuccess (#462) — `shared/` has no test script, so the helper is pinned here for
 * both clients. It rewrites only the exact `ACCOUNT_DELETED` code; any other response passes through
 * as the same object, so a plain `UNAUTHORIZED` still reaches the caller's resend and failure paths.
 * The hooks that wrap it are covered by `extension/tests/unit/dialog/useFamilySettingsDelete.test.ts`
 * and `pwa/tests/unit/hooks/useDeleteAccount.test.ts`.
 */

type DeleteRes = ApiResponse<{ ok: boolean }>;

describe("treatAccountDeletedAsSuccess", () => {
  it("keeps the wire code the Worker answers with", () => {
    expect(ACCOUNT_DELETED_ERROR_CODE).toBe("ACCOUNT_DELETED");
  });

  it("rewrites ACCOUNT_DELETED to a success, dropping the error", () => {
    const res: DeleteRes = {
      error: { code: ACCOUNT_DELETED_ERROR_CODE, message: "這個帳戶已經移除" },
    };

    expect(treatAccountDeletedAsSuccess(res)).toStrictEqual({
      data: { ok: true },
    });
  });

  it.each<[string, DeleteRes]>([
    ["a success", { data: { ok: true } }],
    ["a success reporting false", { data: { ok: false } }],
    ["an empty envelope", {}],
    ["UNAUTHORIZED", { error: { code: "UNAUTHORIZED", message: "revoked" } }],
    [
      "another code carrying the code as its message",
      { error: { code: "SERVER_ERROR", message: ACCOUNT_DELETED_ERROR_CODE } },
    ],
    [
      "the code in another case",
      { error: { code: "account_deleted", message: "x" } },
    ],
    [
      "a code that only starts with it",
      { error: { code: "ACCOUNT_DELETED_LATER", message: "x" } },
    ],
  ])("returns %s unchanged", (_label, res) => {
    expect(treatAccountDeletedAsSuccess(res)).toBe(res);
  });
});
