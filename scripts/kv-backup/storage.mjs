import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BackupError,
  MAX_ARCHIVE_BYTES,
  requireId,
  requireObjectPath,
} from "./format.mjs";

const execute = promisify(execFile);
const wranglerEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../worker/node_modules/wrangler/bin/wrangler.js",
);

export function wranglerEnvironment(env, { accountId, token, directory }) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(KV_BACKUP_|KV_RESTORE_|CLOUDFLARE_|CF_|WRANGLER_)/i.test(key))
      delete clean[key];
  }
  return {
    ...clean,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG: "error",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
    CI: "true",
  };
}

export async function withR2Store(
  { accountId, bucket, token },
  action,
  { env = process.env, run = execute } = {},
) {
  requireId(accountId);
  if (
    typeof bucket !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
  )
    throw new BackupError("R2 bucket 名稱格式不正確。");
  if (typeof token !== "string" || !token.trim())
    throw new BackupError("缺少 KV_BACKUP_R2_API_TOKEN。");
  const directory = await mkdtemp(join(tmpdir(), "moo-kv-backup-"));
  try {
    await chmod(directory, 0o700);
    const config = join(directory, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "moo-kv-backup-tools",
        compatibility_date: "2026-10-01",
      }),
      { mode: 0o600 },
    );
    const childEnv = wranglerEnvironment(env, { accountId, token, directory });
    let sequence = 0;
    async function transfer(verb, key, data) {
      requireObjectPath(
        key,
        key.endsWith(".manifest.json") ? ".manifest.json" : ".jsonl",
      );
      const file = join(directory, `object-${sequence++}`);
      // Pre-create private files before Wrangler opens them for download.
      await writeFile(file, data ?? Buffer.alloc(0), {
        mode: 0o600,
        flag: "wx",
      });
      try {
        await run(
          process.execPath,
          [
            wranglerEntry,
            "r2",
            "object",
            verb,
            `${bucket}/${key}`,
            "--remote",
            "--file",
            file,
            "--config",
            config,
          ],
          {
            cwd: directory,
            env: childEnv,
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          },
        );
        if (verb === "get") {
          const limit = key.endsWith(".manifest.json")
            ? 1024 * 1024
            : MAX_ARCHIVE_BYTES;
          if ((await stat(file)).size > limit)
            throw new BackupError("下載的備份超過容量限制。");
          return await readFile(file);
        }
      } catch (error) {
        if (error instanceof BackupError) throw error;
        throw new BackupError(
          "R2 傳輸失敗或逾時；請檢查專用權限、bucket 與網路設定。",
        );
      } finally {
        await rm(file, { force: true });
      }
    }
    const store = {
      put: async (key, data) => {
        if (!Buffer.isBuffer(data) || data.length > MAX_ARCHIVE_BYTES)
          throw new BackupError("R2 上傳資料超過容量限制。");
        await transfer("put", key, data);
      },
      get: async (key) => transfer("get", key),
    };
    return await action(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
