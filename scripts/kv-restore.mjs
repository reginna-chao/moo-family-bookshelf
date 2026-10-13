#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createKvClient } from "./kv-backup/api.mjs";
import {
  confirmRestore,
  parseOptions,
  readConfig,
  reportError,
} from "./kv-backup/cli.mjs";
import {
  BackupError,
  requireId,
  requireObjectPath,
} from "./kv-backup/format.mjs";
import { runRestore } from "./kv-backup/restore.mjs";
import { withR2Store } from "./kv-backup/storage.mjs";

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args, true);
  if (options.help) {
    console.log(
      "用法：node scripts/kv-restore.mjs --backup <manifest物件路徑> --target-namespace <32位ID> [--max-writes 1000] [--apply]\n預設只檢查備份與空白目標，不寫入 KV。--apply 需在終端機輸入 yes 及 RESTORE <目標ID>。\n必填環境變數：CLOUDFLARE_ACCOUNT_ID、KV_BACKUP_NAMESPACE_ID（正式來源）、KV_BACKUP_BUCKET、KV_BACKUP_R2_API_TOKEN、KV_RESTORE_API_TOKEN。\n不能還原至原始或非空白 namespace；工具不會自動切換正式環境。詳細操作請見 worker/DEPLOY.md。",
    );
    return;
  }
  const config = readConfig(env, true);
  if (options.apply && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new BackupError("--apply 只能在互動終端機執行。");
  }
  const targetNamespaceId = requireId(options["target-namespace"]);
  const manifestKey = requireObjectPath(options.backup, ".manifest.json");
  if (!/^[1-9]\d*$/.test(options["max-writes"]))
    throw new BackupError("--max-writes 必須為正整數。");
  const client = createKvClient({
    accountId: config.accountId,
    namespaceId: targetNamespaceId,
    token: config.kvToken,
  });
  const result = await withR2Store(
    { ...config, token: config.r2Token },
    (store) =>
      runRestore({
        client,
        store,
        manifestKey,
        accountId: config.accountId,
        sourceNamespaceId: config.namespaceId,
        targetNamespaceId,
        apply: options.apply,
        maxWrites: Number(options["max-writes"]),
        confirm: confirmRestore,
      }),
    { env },
  );
  console.log(
    result.applied
      ? `還原及逐筆讀回驗證完成：${result.count} 筆；略過已到期或即將到期 ${result.skipped} 筆。`
      : `檢查完成，尚未寫入：預計還原 ${result.count} 筆；略過已到期或即將到期 ${result.skipped} 筆。`,
  );
  console.log(
    "本次工具上限不代表帳號今日剩餘寫入額度；正式切換前仍須檢查家庭、借閱與分享設定。",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(reportError);
