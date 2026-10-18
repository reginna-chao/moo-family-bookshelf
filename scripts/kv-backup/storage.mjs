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
  MAX_RESTORE_ARCHIVE_BYTES,
  parseJson,
  requireId,
  requireObjectPath,
} from "./format.mjs";

const execute = promisify(execFile);
const wranglerEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../worker/node_modules/wrangler/bin/wrangler.js",
);
const MiB = 1024 * 1024;
// The pointer the backup Worker publishes; the only key outside the snapshot layout.
const LATEST_KEY = "latest.json";

function hasToken(token) {
  return typeof token === "string" && token.trim() !== "";
}

/**
 * The scrubbed child environment for every Wrangler call. Credentials and
 * Wrangler settings inherited from the shell are removed; `CLOUDFLARE_API_TOKEN`
 * is set only when a token is given, otherwise Wrangler falls back to the
 * OAuth login stored by `wrangler login` (HOME / XDG paths are kept).
 */
export function wranglerEnvironment(env, { accountId, token, directory }) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(KV_BACKUP_|KV_RESTORE_|CLOUDFLARE_|CF_|WRANGLER_)/i.test(key))
      delete clean[key];
  }
  const child = {
    ...clean,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG: "error",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
    CI: "true",
  };
  if (hasToken(token)) child.CLOUDFLARE_API_TOKEN = token;
  return child;
}

function requireBucket(bucket) {
  if (
    typeof bucket !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
  )
    throw new BackupError("R2 bucket 名稱格式不正確。");
  return bucket;
}

function runWrangler(workspace, args, { timeout, maxBuffer, env }) {
  return workspace.run(
    process.execPath,
    [wranglerEntry, ...args, "--config", workspace.config],
    {
      cwd: workspace.directory,
      env: env ?? workspace.env,
      windowsHide: true,
      timeout,
      maxBuffer,
      encoding: "utf8",
    },
  );
}

function downloadLimit(key) {
  if (key === LATEST_KEY) return MiB;
  const manifest = typeof key === "string" && key.endsWith(".manifest.json");
  requireObjectPath(key, manifest ? ".manifest.json" : ".jsonl");
  return manifest ? MiB : MAX_RESTORE_ARCHIVE_BYTES;
}

function createR2Store(workspace, bucket) {
  requireBucket(bucket);
  async function download(key) {
    const limit = downloadLimit(key);
    const file = join(workspace.directory, `object-${workspace.sequence++}`);
    // Pre-create private files before Wrangler opens them for download.
    await writeFile(file, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    // Large objects need more than the flat 2 minutes: add 2 s per MiB moved.
    const timeout = 120_000 + 2_000 * Math.ceil(limit / MiB);
    try {
      await runWrangler(
        workspace,
        ["r2", "object", "get", `${bucket}/${key}`, "--remote", "--file", file],
        { timeout, maxBuffer: MiB },
      );
      if ((await stat(file)).size > limit)
        throw new BackupError("下載的備份超過容量限制。");
      return await readFile(file);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(
        "R2 傳輸失敗或逾時；請確認已 wrangler login 或 token 權限正確、bucket 名稱與網路設定。",
      );
    } finally {
      await rm(file, { force: true });
    }
  }
  return { get: download };
}

function toListedKeys(output) {
  if (typeof output !== "string")
    throw new BackupError("KV 列舉回應格式不正確。");
  const keys = parseJson(output);
  if (
    !Array.isArray(keys) ||
    keys.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.name !== "string",
    )
  )
    throw new BackupError("KV 列舉回應格式不正確。");
  return keys.map(({ name, expiration }) =>
    typeof expiration === "number" ? { name, expiration } : { name },
  );
}

/** A KvClient that can only list: the drill can never read or write KV. */
function createListOnlyKvClient(workspace, namespaceId) {
  requireId(namespaceId);
  async function listKeys() {
    let result;
    try {
      result = await runWrangler(
        workspace,
        ["kv", "key", "list", "--namespace-id", namespaceId, "--remote"],
        {
          timeout: 120_000,
          maxBuffer: 16 * MiB,
          // `kv key list` prints its JSON at the "log" level, which "error" hides.
          env: { ...workspace.env, WRANGLER_LOG: "log" },
        },
      );
    } catch {
      throw new BackupError(
        "KV 列舉失敗；請確認已 wrangler login、帳號正確且隔離 namespace 存在。",
      );
    }
    return toListedKeys(result?.stdout);
  }
  async function refuse() {
    throw new BackupError("演練工具只能列舉 KV，不支援讀取或寫入。");
  }
  return { listKeys, readKeys: refuse, writeRecords: refuse };
}

/**
 * Runs `action` inside ONE private temporary Wrangler workspace (0700 dir,
 * 0600 `wrangler.json`, scrubbed env) shared by an R2 store factory and a
 * list-only KV client factory; the workspace is removed afterwards. `token`
 * is optional — without it Wrangler uses the local `wrangler login` identity.
 */
export async function withWrangler(
  { accountId, token },
  action,
  { env = process.env, run = execute } = {},
) {
  requireId(accountId);
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
    const workspace = {
      directory,
      config,
      run,
      env: wranglerEnvironment(env, { accountId, token, directory }),
      sequence: 0,
    };
    return await action({
      r2: (bucket) => createR2Store(workspace, bucket),
      kv: (namespaceId) => createListOnlyKvClient(workspace, namespaceId),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs `action` with an R2 store for `bucket` (the restore CLI's path). Unlike
 * `withWrangler`, the dedicated R2 API `token` is required here.
 */
export async function withR2Store(
  { accountId, bucket, token },
  action,
  options,
) {
  requireId(accountId);
  requireBucket(bucket);
  if (!hasToken(token)) throw new BackupError("缺少 KV_BACKUP_R2_API_TOKEN。");
  return withWrangler(
    { accountId, token },
    (tools) => action(tools.r2(bucket)),
    options,
  );
}
