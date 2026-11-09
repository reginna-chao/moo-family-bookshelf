import type { DeleteAccountBody } from "./verifyTypes";

/**
 * The `{ currentSecret }` body of a self-leave (`DELETE /api/family/:id/member/:uid`)
 * or an ownership transfer (`PUT /api/family/:id/transfer`); `undefined` when no
 * secret was given, so the request carries none. Same shape as `DeleteAccountBody`.
 */
export function currentSecretBody(
  currentSecret?: string,
): DeleteAccountBody | undefined {
  return currentSecret === undefined ? undefined : { currentSecret };
}
