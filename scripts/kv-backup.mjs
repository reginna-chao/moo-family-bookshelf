#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createKvClient } from "./kv-backup/api.mjs";
import { runBackup } from "./kv-backup/backup.mjs";
import { parseOptions, readConfig, reportError } from "./kv-backup/cli.mjs";
import { withR2Store } from "./kv-backup/storage.mjs";

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(
      "用法：node scripts/kv-backup.mjs\n完整備份正式 KV 到私人 R2，資料上傳後會下載驗證。\n必填環境變數：CLOUDFLARE_ACCOUNT_ID、KV_BACKUP_NAMESPACE_ID、KV_BACKUP_BUCKET、KV_BACKUP_API_TOKEN、KV_BACKUP_R2_API_TOKEN。\n詳細設定與還原步驟請見 worker/DEPLOY.md。",
    );
    return;
  }
  const config = readConfig(env);
  const client = createKvClient({ ...config, token: config.kvToken });
  const result = await withR2Store(
    { ...config, token: config.r2Token },
    (store) =>
      runBackup({
        client,
        store,
        accountId: config.accountId,
        namespaceId: config.namespaceId,
      }),
    { env },
  );
  console.log(
    `備份完成：${result.manifest.count} 筆，${result.manifest.byteLength} bytes。`,
  );
  console.log(`備份清單：${result.manifestKey}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(reportError);
