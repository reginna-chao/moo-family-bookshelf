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

export async function reportSuccess(
  uuid: string,
  budget: RunBudget,
  fetcher: typeof fetch = fetch,
) {
  requireHealthchecksUuid(uuid);
  for (let attempt = 0; attempt < 3; attempt++) {
    budget.check();
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
        if (new TextDecoder().decode(bytes) === "OK") return;
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
  throw new BackupError("備份已保留，但獨立監看回報失敗。");
}
