import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { BackupError, requireId } from "./format.mjs";

export function readConfig(env = process.env, restore = false) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new BackupError("備份工具需要 Node.js 22 或更新版本。");
  const required = (name) => {
    const value = env[name];
    if (typeof value !== "string" || !value.trim())
      throw new BackupError(`請設定 ${name}。`);
    return value;
  };
  return {
    accountId: requireId(required("CLOUDFLARE_ACCOUNT_ID")),
    namespaceId: requireId(required("KV_BACKUP_NAMESPACE_ID")),
    bucket: required("KV_BACKUP_BUCKET"),
    r2Token: required("KV_BACKUP_R2_API_TOKEN"),
    kvToken: required(restore ? "KV_RESTORE_API_TOKEN" : "KV_BACKUP_API_TOKEN"),
  };
}

export function parseOptions(args, restore = false) {
  try {
    return parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        ...(restore
          ? {
              backup: { type: "string" },
              "target-namespace": { type: "string" },
              apply: { type: "boolean", default: false },
              "max-writes": { type: "string", default: "1000" },
            }
          : {}),
      },
    }).values;
  } catch {
    throw new BackupError("參數格式不正確，請使用 --help 查看用法。");
  }
}

export async function confirmRestore({ targetNamespaceId, count, maxWrites }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new BackupError("--apply 只能在互動終端機執行。");
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(
      `將還原最多 ${count} 筆至隔離 namespace ${targetNamespaceId}，本次上限 ${maxWrites} 筆。`,
    );
    console.log(
      "工具無法得知今天已用掉的 KV 寫入額度；請先確認剩餘額度，並確保目標沒有其他寫入者。",
    );
    if ((await reader.question("確認繼續？請輸入 yes：")) !== "yes")
      return false;
    return (
      (await reader.question(
        `再次確認，請輸入 RESTORE ${targetNamespaceId}：`,
      )) === `RESTORE ${targetNamespaceId}`
    );
  } finally {
    reader.close();
  }
}

export function reportError(error) {
  console.error(
    error instanceof BackupError
      ? error.message
      : "執行失敗，未輸出可能含敏感資料的錯誤內容。",
  );
  process.exitCode = 1;
}
