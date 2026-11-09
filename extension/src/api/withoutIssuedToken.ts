import type { ApiResponse } from "./types";
import type { SetVerifyResult } from "moo-family-bookshelf-shared/api/verifyTypes";

/** A verify response from a server this client has left: its token must reach neither the client nor
 *  the caller, whose storage check compares the client's CURRENT server (`dialog/saveVerifyMethod.ts`). */
export function withoutIssuedToken(
  res: ApiResponse<SetVerifyResult>,
): ApiResponse<SetVerifyResult> {
  const issued = res.data;
  if (issued?.authToken === undefined && issued?.expiresAt === undefined) {
    return res;
  }
  const data = { ...issued };
  delete data.authToken;
  delete data.expiresAt;
  return { ...res, data };
}
