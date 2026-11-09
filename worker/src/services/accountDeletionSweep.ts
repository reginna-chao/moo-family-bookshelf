/** Cron sweep (#468): the main guarantee that data written back after an account deletion is removed, needing no
 *  writer's cooperation. Numbers and residuals: docs/architecture.md → 家庭成員的授權與移除. */
import {
  deleteAccountDeletingMark,
  getAccountDeletingMark,
  listAccountDeletingPage,
} from "../kv/accountDeleting";
import { kvKeys } from "../kv/schema";
import { wipeAccountData } from "./accountDeletion";
import { HEX_64 } from "./authRecord";

/** A mark this old, on a pass that wiped without an error, is retired. */
export const SWEEP_RETIRE_AFTER_MS = 60 * 60 * 1000;

/** Equal to the cron in `worker/wrangler.toml`; only used to rotate which accounts one run takes. */
export const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** Accounts per run. At the worst case of ~64 KV operations each, one run stays under 1,000. */
export const MAX_SWEEP_ACCOUNTS_PER_RUN = 10;

/** The userIds on one list page; only names of the expected shape, so a stray key cannot steer a wipe. */
function markedUserIds(page: KVNamespaceListResult<unknown>): string[] {
  const prefix = kvKeys.accountDeleting("");
  return page.keys
    .map((key) => key.name)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((tail) => HEX_64.test(tail));
}

/** Stateless rotation: this run's slice of the list, wrapping at the end. Marks coming and going shift the indexes,
 *  so an account can miss a run, but its mark stays until it is reached. */
function selectThisRun(userIds: string[], scheduledTime: number): string[] {
  const total = userIds.length;
  const start =
    (Math.floor(scheduledTime / SWEEP_INTERVAL_MS) *
      MAX_SWEEP_ACCOUNTS_PER_RUN) %
    total;
  return Array.from(
    { length: Math.min(total, MAX_SWEEP_ACCOUNTS_PER_RUN) },
    (_, offset) => userIds[(start + offset) % total],
  );
}

/** Wipe one account and retire its mark once it is old enough. Never decides "this account was re-created": only an
 *  admitted create / join can end a deletion, because a token's age cannot tell a re-creation from a race. */
async function sweepAccount(kv: KVNamespace, userId: string): Promise<void> {
  const mark = await getAccountDeletingMark(kv, userId);
  if (mark === null) return;
  await wipeAccountData(kv, userId, mark);
  if (Date.now() - mark.startedAt >= SWEEP_RETIRE_AFTER_MS) {
    await deleteAccountDeletingMark(kv, userId);
  }
}

/**
 * One scheduled run: list the marks once, take this run's slice, and settle each
 * account in turn. A failed list logs and ends the run (the next run retries); a failed
 * account logs, keeps its mark and does not stop the next one. Never throws; the logs
 * carry the event name only (#357). Marks past the first list page wait: accepted in
 * docs/architecture.md → 已接受的殘餘風險.
 */
export async function sweepDeletedAccounts(
  kv: KVNamespace,
  scheduledTime: number,
): Promise<void> {
  let userIds: string[];
  try {
    userIds = markedUserIds(await listAccountDeletingPage(kv));
  } catch {
    console.error("ACCOUNT_DELETION_SWEEP_FAILED");
    return;
  }
  if (userIds.length === 0) return;

  for (const userId of selectThisRun(userIds, scheduledTime)) {
    try {
      await sweepAccount(kv, userId);
    } catch {
      console.error("ACCOUNT_DELETION_SWEEP_FAILED");
    }
  }
}
