#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatRestoreSummary,
  parseCliOptions,
  reportError,
  requireNode22,
} from "./kv-backup/cli.mjs";
import { readDrillConfig } from "./kv-backup/drillConfig.mjs";
import {
  BackupError,
  MAX_KEYS,
  parseJson,
  requireObjectPath,
} from "./kv-backup/format.mjs";
import { requireEmpty, runRestore } from "./kv-backup/restore.mjs";
import { withWrangler } from "./kv-backup/storage.mjs";

const DEFAULT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../worker/wrangler.backup.local.toml",
);

const USAGE =
  "用法：pnpm backup:drill（或 node scripts/kv-restore-drill.mjs）\n對最新一份備份做每月還原 dry-run：讀取 worker/wrangler.backup.local.toml 的 account_id、SOURCE_NAMESPACE_ID、RESTORE_DRILL_NAMESPACE_ID 與 bucket_name，下載 latest.json 指向的備份並完整驗證，確認演練 namespace 是空的。\n使用本機 wrangler login 的登入身分，不需要任何環境變數或 API token；永遠不寫入 KV。\n真正寫入的 --apply 還原仍要用 scripts/kv-restore.mjs，步驟見 worker/DEPLOY.md。";

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
    formatRestoreSummary(result),
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
  if (parseCliOptions(args, { help: { type: "boolean", short: "h" } }).help) {
    log(USAGE);
    return;
  }
  requireNode22();
  const config = await readDrillConfig(configPath);
  // Checked before any Wrangler call, so a misconfigured drill never lists production.
  if (config.drillNamespaceId === config.sourceNamespaceId)
    throw new BackupError(
      "禁止寫入來源或正式 namespace，請建立新的隔離 namespace。",
    );
  const result = await withWrangler(
    { accountId: config.accountId },
    (tools) => drill(tools, config),
    { env, run },
  );
  for (const line of summarize(result)) log(line);
}

// Empty-namespace check first, so a non-empty drill target costs no download.
async function drill({ r2, kv }, config) {
  const client = kv(config.drillNamespaceId);
  await requireEmpty(client);
  const store = r2(config.bucket);
  const manifestKey = readLatestManifestKey(
    await store.get("latest.json"),
    config,
  );
  return runRestore({
    client,
    store,
    manifestKey,
    accountId: config.accountId,
    sourceNamespaceId: config.sourceNamespaceId,
    targetNamespaceId: config.drillNamespaceId,
    apply: false,
    maxWrites: MAX_KEYS,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(reportError);
