/** Post-write check of `DELETE /api/user/:id` (#468): a token-bearing write that finished after the deletion started
 *  has its data wiped and answers 401. See docs/architecture.md → 家庭成員的授權與移除. */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import { getAccountDeletingMark } from "../kv/accountDeleting";
import type { AccountDeletingMark } from "../kv/schema";
import {
  isTokenAfterDeletion,
  wipeAccountData,
} from "../services/accountDeletion";
import { hashAuthToken } from "../utils/crypto";
import { jsonError } from "../utils/errors";
import { accountDeleteTargetUserId } from "../utils/routes";
import {
  getAuthenticatedUserId,
  getAuthTokenCreatedAt,
  getPresentedAuthToken,
} from "./auth";

const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

/** The mark, or `null` when there is none or it cannot be read; a read failure leaves the rest to the sweep. */
async function readMarkFailOpen(
  kv: KVNamespace,
  userId: string,
): Promise<AccountDeletingMark | null> {
  try {
    return await getAccountDeletingMark(kv, userId);
  } catch {
    console.error("ACCOUNT_DELETION_GUARD_FAILED");
    return null;
  }
}

/** Wipe including the presented token; a failure leaves the rest to the sweep and the answer is still 401. */
async function wipeFailOpen(
  c: Context<{ Bindings: Env }>,
  userId: string,
  mark: AccountDeletingMark,
): Promise<void> {
  try {
    const token = getPresentedAuthToken(c);
    await wipeAccountData(c.env.KV, userId, mark, {
      extraTokenHashes: token === null ? [] : [await hashAuthToken(token)],
    });
  } catch {
    console.error("ACCOUNT_DELETION_GUARD_FAILED");
  }
}

/**
 * Runs after the handler, an `onError` response included. An authenticated non-GET
 * request pays one mark read and nothing else unless a mark exists. With a mark, a
 * token newer than the mark passes: that only happens on a colo still caching the
 * mark a re-creation already deleted, or for a token a race minted, which the sweep
 * removes. Anything older is wiped and answered like an invalid token; assigning
 * `c.res` keeps the CORS headers already on the response.
 */
export const accountDeletionGuard = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    await next();

    const { method, path } = c.req;
    const userId = getAuthenticatedUserId(c);
    if (
      !userId ||
      READ_ONLY_METHODS.has(method) ||
      accountDeleteTargetUserId(method, path) !== null
    ) {
      return;
    }

    const mark = await readMarkFailOpen(c.env.KV, userId);
    if (mark === null) return;
    if (isTokenAfterDeletion(getAuthTokenCreatedAt(c), mark)) return;

    await wipeFailOpen(c, userId, mark);
    c.res = jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
  },
);
