#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reportError, requireNode22 } from "./kv-backup/cli.mjs";
import { readDrillConfig } from "./kv-backup/drillConfig.mjs";
import {
  BackupError,
  MAX_KEYS,
  parseJson,
  requireObjectPath,
} from "./kv-backup/format.mjs";
import { runRestore } from "./kv-backup/restore.mjs";
import { withWrangler } from "./kv-backup/storage.mjs";

const DEFAULT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../worker/wrangler.backup.local.toml",
);

const USAGE =
  "用法：pnpm backup:drill（或 node scripts/kv-restore-drill.mjs）\n對最新一份備份做每月還原 dry-run：讀取 worker/wrangler.backup.local.toml 的 account_id、SOURCE_NAMESPACE_ID、RESTORE_DRILL_NAMESPACE_ID 與 bucket_name，下載 latest.json 指向的備份並完整驗證，確認演練 namespace 是空的。\n使用本機 wrangler login 的登入身分，不需要任何環境變數或 API token；永遠不寫入 KV。\n真正寫入的 --apply 還原仍要用 scripts/kv-restore.mjs，步驟見 worker/DEPLOY.md。";

function parseDrillOptions(args) {
  try {
    return parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { help: { type: "boolean", short: "h" } },
    }).values;
  } catch {
    throw new BackupError("參數格式不正確，請使用 --help 查看用法。");
  }
}

function readLatestManifestKey(bytes, config) {
  const latest = parseJson(bytes.toString("utf8"));
  if (latest === null || typeof latest !== "object" || Array.isArray(latest))
    throw new BackupError("latest.json 格式不正確。");
  const manifestKey = requireObjectPath(latest.manifestKey, ".manifest.json");
  if (
    latest.sourceAccountId !== config.accountId ||
    latest.sourceNamespaceId !== config.sourceNamespaceId
  )
    throw new BackupError(
      "latest.json 的來源帳號或 namespace 與本機設定不符。",
    );
  return manifestKey;
}

function formatRequests(requests) {
  if (
    requests === null ||
    typeof requests !== "object" ||
    !Number.isSafeInteger(requests.internal) ||
    !Number.isSafeInteger(requests.external)
  )
    return "—";
  return `${requests.internal}／${requests.external}`;
}

function summarize(result) {
  const { manifest } = result;
  // Date.parse tolerates parenthesised junk, so print the ISO form: the raw
  // string could carry terminal escape sequences to stdout.
  const completedAt = new Date(Date.parse(manifest.completedAt)).toISOString();
  return [
    `檢查完成，尚未寫入：預計還原 ${result.count} 筆；略過已到期或即將到期 ${result.skipped} 筆。`,
    `備份完成時間 ${completedAt}；筆數 ${manifest.count}；大小 ${manifest.byteLength} bytes；請求數（內部／對外）${formatRequests(manifest.requests)}。`,
    "請到 Healthchecks 的月度 dry-run 提醒 check 按 Ping Now，並把這次結果記進維運紀錄。",
  ];
}

export async function main(
  args = process.argv.slice(2),
  {
    env = process.env,
    run,
    configPath = DEFAULT_CONFIG_PATH,
    log = console.log,
  } = {},
) {
  if (parseDrillOptions(args).help) {
    log(USAGE);
    return;
  }
  requireNode22();
  const config = await readDrillConfig(configPath);
  const result = await withWrangler(
    { accountId: config.accountId },
    async ({ r2, kv }) => {
      const store = r2(config.bucket);
      const manifestKey = readLatestManifestKey(
        await store.get("latest.json"),
        config,
      );
      return runRestore({
        client: kv(config.drillNamespaceId),
        store,
        manifestKey,
        accountId: config.accountId,
        sourceNamespaceId: config.sourceNamespaceId,
        targetNamespaceId: config.drillNamespaceId,
        apply: false,
        maxWrites: MAX_KEYS,
      });
    },
    { env, run },
  );
  for (const line of summarize(result)) log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(reportError);
