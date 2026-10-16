import { BackupError } from "../../../scripts/kv-backup/format.mjs";
import { readBounded, RunBudget } from "./runtime";

export function requireHealthchecksUuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new BackupError("獨立備份監看尚未設定完成。");
  return value;
}

/**
 * Sends an empty POST to the Healthchecks check `uuid`, up to 3 attempts with
 * a 10 s timeout each; every attempt is one external request on `budget`.
 * Resolves true only when the check answered 200 with the body `OK`.
 */
export async function pingCheck(
  uuid: string,
  budget: RunBudget,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  requireHealthchecksUuid(uuid);
  for (let attempt = 0; attempt < 3; attempt++) {
    budget.countExternal();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(`https://hc-ping.com/${uuid}`, {
        method: "POST",
        body: "",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status === 200 && response.body) {
        const bytes = await readBounded(response.body, 128, budget);
        if (new TextDecoder().decode(bytes) === "OK") return true;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Never expose a secret URL or a remote response in logs.
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 2) await budget.sleep(1000);
  }
  return false;
}
