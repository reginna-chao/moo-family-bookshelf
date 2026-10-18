import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseBackupLocalConfig,
  readDrillConfig,
} from "../../../scripts/kv-backup/drillConfig.mjs";
import {
  withR2Store,
  withWrangler,
  wranglerEnvironment,
  type WranglerRun,
} from "../../../scripts/kv-backup/storage.mjs";
import { main } from "../../../scripts/kv-restore-drill.mjs";
import {
  ACCOUNT,
  DATA_KEY,
  MANIFEST_KEY,
  NOW,
  SOURCE,
  TARGET,
  seededArchive,
} from "../helpers/kvBackupFixtures";

/**
 * The monthly restore dry-run `pnpm backup:drill` (`scripts/kv-restore-drill.mjs`)
 * and the pieces it adds: the local-config scanner (`drillConfig.mjs`), the
 * token-optional Wrangler environment and the list-only KV client
 * (`storage.mjs` → `withWrangler`).
 *
 * SEAM. Every Wrangler call goes through the injected `run` (the `execFile`
 * signature). The fake serves `r2 object get` from an in-memory object map by
 * writing the bytes to the `--file` path, and answers `kv key list` with canned
 * stdout; nothing reaches the real `wrangler`, the network or a real
 * `wrangler.backup.local.toml` (configs are temp files under `mkdtemp`).
 *
 * TIME. `main` does not inject `now`, so the drill flow fakes only `Date` at
 * the fixture's `NOW`; the seeded archive's two expiring records then count as
 * restorable, matching `kvRestore.test.ts`'s dry run (10 restorable, 0 skipped).
 *
 * NO-WRITE GUARANTEE. Asserted structurally: every recorded call is either
 * `r2 object get` or `kv key list`, and `readKeys` / `writeRecords` of the
 * list-only client always reject. Messages are asserted exactly.
 */

const BUCKET = "backup-bucket";
const OTHER_ID = "d".repeat(32);
const COMPLETED_AT = new Date(NOW).toISOString();
const MISSING_FILE =
  "找不到 worker/wrangler.backup.local.toml，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節建立並填好設定。";
const BAD_ID = "帳號及 namespace 必須明確指定為 32 位小寫十六進位 ID。";
const BAD_PATH = "備份物件路徑格式不正確。";
const LIST_FAILED =
  "KV 列舉失敗；請確認已 wrangler login、帳號正確且隔離 namespace 存在。";
const LIST_SHAPE = "KV 列舉回應格式不正確。";
const NOT_JSON = "備份或伺服器資料不是有效的 JSON。";
const REFUSED = "演練工具只能列舉 KV，不支援讀取或寫入。";
const MISSING_R2_TOKEN = "缺少 KV_BACKUP_R2_API_TOKEN。";
const missingField = (what: string) =>
  `worker/wrangler.backup.local.toml 缺少${what}，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節補上。`;

interface LocalConfig {
  account?: string;
  source?: string;
  drill?: string;
  bucket?: string;
}

/** The template layout of `worker/wrangler.backup.toml` plus the drill's top-level `account_id`. */
function localToml({
  account = ACCOUNT,
  source = SOURCE,
  drill = TARGET,
  bucket = BUCKET,
}: LocalConfig = {}): string {
  return [
    'name = "moo-family-bookshelf-backup"',
    'main = "src/backup/index.ts"',
    'compatibility_date = "2026-09-15"',
    'compatibility_flags = ["nodejs_compat"]',
    "workers_dev = false",
    `account_id = "${account}"`,
    "",
    "# Copy to wrangler.backup.local.toml; configure and validate before enabling.",
    "[vars]",
    'BACKUP_ENABLED = "true"',
    `SOURCE_ACCOUNT_ID = "${account}"`,
    `SOURCE_NAMESPACE_ID = "${source}"`,
    "# Read only by `pnpm backup:drill` (the Worker ignores it).",
    `RESTORE_DRILL_NAMESPACE_ID = "${drill}"   # empty isolated namespace`,
    "",
    "[[kv_namespaces]]",
    'binding = "BACKUP_KV"',
    `id = "${OTHER_ID}"`,
    "",
    "[[r2_buckets]]",
    'binding = "BACKUP_BUCKET"',
    `bucket_name = "${bucket}"`,
    "",
    "[triggers]",
    'crons = ["17 3 * * *"]',
    "",
  ].join("\n");
}

const EXPECTED = {
  accountId: ACCOUNT,
  sourceNamespaceId: SOURCE,
  drillNamespaceId: TARGET,
  bucket: BUCKET,
};

let scratch = "";

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "moo-drill-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(scratch, { recursive: true, force: true });
});

async function writeConfig(text: string): Promise<string> {
  const path = join(scratch, "wrangler.backup.local.toml");
  await writeFile(path, text);
  return path;
}

describe("parseBackupLocalConfig", () => {
  it.each([
    ["LF", localToml()],
    ["CRLF", localToml().replace(/\n/g, "\r\n")],
    ["a UTF-8 BOM", "﻿" + localToml()],
  ])(
    "reads the four drill settings from the template layout (%s)",
    (_label, text) => {
      expect(parseBackupLocalConfig(text)).toEqual(EXPECTED);
    },
  );

  it("never takes the [[kv_namespaces]] id for any setting", () => {
    const config = parseBackupLocalConfig(localToml());
    expect(Object.values(config)).not.toContain(OTHER_ID);
    // Positive companion: the id really is in the scanned text.
    expect(localToml()).toContain(`id = "${OTHER_ID}"`);
  });

  it("keeps a # inside a quoted value and drops a trailing comment", () => {
    const text = localToml().replace(
      `bucket_name = "${BUCKET}"`,
      'bucket_name = "moo#backups" # private bucket',
    );
    expect(parseBackupLocalConfig(text).bucket).toBe("moo#backups");
  });

  it("uses the first [[r2_buckets]] entry", () => {
    const text = `${localToml()}\n[[r2_buckets]]\nbinding = "SECOND"\nbucket_name = "second-bucket"\n`;
    expect(parseBackupLocalConfig(text).bucket).toBe(BUCKET);
  });

  it('never attributes a quoted-key [env."…".vars] table\'s values to [vars]', () => {
    const text = localToml()
      .replace(`SOURCE_NAMESPACE_ID = "${SOURCE}"\n`, "")
      .replace(
        "[[kv_namespaces]]\n",
        `[env."staging".vars]\nSOURCE_NAMESPACE_ID = "${SOURCE}"\n\n[[kv_namespaces]]\n`,
      );
    // Positive companion: the staging table really carries the id.
    expect(text).toContain(
      `[env."staging".vars]\nSOURCE_NAMESPACE_ID = "${SOURCE}"`,
    );
    expect(() => parseBackupLocalConfig(text)).toThrow(
      missingField(" [vars] 的 SOURCE_NAMESPACE_ID"),
    );
  });

  it('keeps the [vars] value when a later [env."…".vars] table repeats the key', () => {
    const text = localToml().replace(
      "[[kv_namespaces]]\n",
      `[env."staging".vars]\nRESTORE_DRILL_NAMESPACE_ID = "${OTHER_ID}"\n\n[[kv_namespaces]]\n`,
    );
    expect(text).toContain(`RESTORE_DRILL_NAMESPACE_ID = "${OTHER_ID}"`);
    expect(parseBackupLocalConfig(text)).toEqual(EXPECTED);
  });

  it.each([
    [
      "the top-level account_id",
      (text: string) => text.replace(`account_id = "${ACCOUNT}"\n`, ""),
      missingField("頂層 account_id"),
    ],
    [
      "account_id written only under [vars]",
      (text: string) =>
        text
          .replace(`account_id = "${ACCOUNT}"\n`, "")
          .replace("[vars]\n", `[vars]\naccount_id = "${ACCOUNT}"\n`),
      missingField("頂層 account_id"),
    ],
    [
      "SOURCE_NAMESPACE_ID",
      (text: string) => text.replace(`SOURCE_NAMESPACE_ID = "${SOURCE}"\n`, ""),
      missingField(" [vars] 的 SOURCE_NAMESPACE_ID"),
    ],
    [
      "RESTORE_DRILL_NAMESPACE_ID",
      (text: string) => text.replace(/RESTORE_DRILL_NAMESPACE_ID = .*\n/, ""),
      missingField(" [vars] 的 RESTORE_DRILL_NAMESPACE_ID"),
    ],
    [
      "RESTORE_DRILL_NAMESPACE_ID placed under [[kv_namespaces]]",
      (text: string) =>
        text
          .replace(/RESTORE_DRILL_NAMESPACE_ID = .*\n/, "")
          .replace(
            'binding = "BACKUP_KV"\n',
            `binding = "BACKUP_KV"\nRESTORE_DRILL_NAMESPACE_ID = "${TARGET}"\n`,
          ),
      missingField(" [vars] 的 RESTORE_DRILL_NAMESPACE_ID"),
    ],
    [
      "bucket_name",
      (text: string) => text.replace(`bucket_name = "${BUCKET}"\n`, ""),
      missingField(" [[r2_buckets]] 的 bucket_name"),
    ],
  ])("rejects a file missing %s", (_label, edit, message) => {
    const text = edit(localToml());
    expect(text).not.toBe(localToml());
    expect(() => parseBackupLocalConfig(text)).toThrow(message);
  });

  it.each([
    ["the template placeholder", { drill: "YOUR_EMPTY_DRILL_KV_NAMESPACE_ID" }],
    ["an uppercase id", { drill: TARGET.toUpperCase() }],
    ["a 31-character account", { account: "a".repeat(31) }],
    ["an empty source", { source: "" }],
  ])("rejects %s with the id literal", (_label, override: LocalConfig) => {
    expect(() => parseBackupLocalConfig(localToml(override))).toThrow(BAD_ID);
  });
});

describe("readDrillConfig", () => {
  it("reads a config file from disk", async () => {
    await expect(
      readDrillConfig(await writeConfig(localToml())),
    ).resolves.toEqual(EXPECTED);
  });

  it("reports a missing file with one literal", async () => {
    await expect(
      readDrillConfig(join(scratch, "wrangler.backup.local.toml")),
    ).rejects.toThrow(MISSING_FILE);
  });

  it("reports an unreadable path (a directory) with the same literal", async () => {
    const directory = join(scratch, "as-directory.toml");
    await mkdir(directory);
    await expect(readDrillConfig(directory)).rejects.toThrow(MISSING_FILE);
  });
});

describe("wranglerEnvironment", () => {
  const inherited: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/admin",
    CLOUDFLARE_API_TOKEN: "deploy",
    KV_BACKUP_API_TOKEN: "kv-read",
    KV_RESTORE_API_TOKEN: "kv-write",
    CF_API_KEY: "global",
    WRANGLER_API_TOKEN: "wrangler",
  };

  it.each([
    ["no token", undefined],
    ["a blank token", "   "],
  ])(
    "leaves CLOUDFLARE_API_TOKEN unset with %s and scrubs inherited credentials",
    (_label, token) => {
      const child = wranglerEnvironment(inherited, {
        accountId: ACCOUNT,
        token,
        directory: scratch,
      });
      expect(child).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
      for (const key of [
        "KV_BACKUP_API_TOKEN",
        "KV_RESTORE_API_TOKEN",
        "CF_API_KEY",
        "WRANGLER_API_TOKEN",
      ])
        expect(child).not.toHaveProperty(key);
      expect(child).toMatchObject({
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        CI: "true",
        WRANGLER_LOG: "error",
        PATH: "/usr/bin",
        HOME: "/home/admin",
      });
    },
  );

  it("sets CLOUDFLARE_API_TOKEN to the given token", () => {
    const child = wranglerEnvironment(inherited, {
      accountId: ACCOUNT,
      token: "r2-only",
      directory: scratch,
    });
    expect(child.CLOUDFLARE_API_TOKEN).toBe("r2-only");
    expect(child).not.toHaveProperty("KV_BACKUP_API_TOKEN");
  });
});

interface Call {
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  cwd: string;
}

/** Fake `run`: serves R2 gets from `objects` (by key after the bucket) and answers `kv key list` with `listed`. */
function fakeWrangler(
  objects: Map<string, Buffer> = new Map(),
  listed: () => unknown = () => ({ stdout: "[]", stderr: "" }),
) {
  const calls: Call[] = [];
  const run: WranglerRun = async (file, args, options) => {
    expect(file).toBe(process.execPath);
    calls.push({
      args,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      cwd: options.cwd,
    });
    const command = args.slice(1, 4).join(" ");
    if (command === "kv key list") return listed();
    if (command !== "r2 object get") throw new Error("unexpected command");
    const key = args[4].slice(args[4].indexOf("/") + 1);
    const data = objects.get(key);
    if (!data) throw new Error("missing fixture object");
    await writeFile(args[args.indexOf("--file") + 1], data);
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

const listCalls = (calls: Call[]) =>
  calls.filter((call) => call.args.slice(1, 4).join(" ") === "kv key list");

describe("withR2Store without a token", () => {
  it.each([
    ["no token", undefined],
    ["a blank token", "   "],
  ])("rejects %s before running Wrangler", async (_label, token) => {
    const { calls, run } = fakeWrangler(
      new Map([[DATA_KEY, Buffer.from("archive")]]),
    );
    const action = vi.fn((store: { get(key: string): Promise<Buffer> }) =>
      store.get(DATA_KEY),
    );
    await expect(
      withR2Store(
        { accountId: ACCOUNT, bucket: BUCKET, token: token as string },
        action,
        { run, env: { PATH: process.env.PATH } },
      ),
    ).rejects.toThrow(MISSING_R2_TOKEN);
    expect(action).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("withWrangler R2 store without a token", () => {
  it("downloads through the injected run without CLOUDFLARE_API_TOKEN", async () => {
    const { calls, run } = fakeWrangler(
      new Map([[DATA_KEY, Buffer.from("archive")]]),
    );
    const bytes = await withWrangler(
      { accountId: ACCOUNT },
      ({ r2 }) => r2(BUCKET).get(DATA_KEY),
      { run, env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: "deploy" } },
    );
    expect(bytes.toString()).toBe("archive");
    expect(calls).toHaveLength(1);
    expect(calls[0].env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(calls[0].env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
  });
});

describe("withWrangler list-only KV client", () => {
  async function list(listed: () => unknown) {
    const fake = fakeWrangler(new Map(), listed);
    const result = withWrangler(
      { accountId: ACCOUNT },
      async ({ kv }) => kv(TARGET).listKeys(),
      { run: fake.run, env: { PATH: process.env.PATH } },
    );
    return { ...fake, result };
  }

  it("runs exactly `kv key list --namespace-id <id> --remote` at the log level", async () => {
    const { calls, result } = await list(() => ({ stdout: "[]", stderr: "" }));
    await expect(result).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.args.slice(1)).toEqual([
      "kv",
      "key",
      "list",
      "--namespace-id",
      TARGET,
      "--remote",
      "--config",
      join(call.cwd, "wrangler.json"),
    ]);
    expect(call.env.WRANGLER_LOG).toBe("log");
    expect(call.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(call.timeout).toBe(120_000);
    expect(call.maxBuffer).toBe(16 * 1024 * 1024);
    expect(existsSync(call.cwd)).toBe(false);
  });

  it("keeps only name and a numeric expiration of each listed key", async () => {
    const { result } = await list(() => ({
      stdout:
        '[{"name":"user:a","expiration":123,"metadata":{"x":1}},{"name":"x"},{"name":"y","expiration":"soon"}]',
      stderr: "",
    }));
    await expect(result).resolves.toEqual([
      { name: "user:a", expiration: 123 },
      { name: "x" },
      { name: "y" },
    ]);
  });

  it.each([
    ["stdout that is not JSON", { stdout: "not json" }, NOT_JSON],
    ["an object instead of an array", { stdout: "{}" }, LIST_SHAPE],
    ["an entry without a string name", { stdout: '[{"name":1}]' }, LIST_SHAPE],
    ["a null entry", { stdout: "[null]" }, LIST_SHAPE],
    ["no stdout at all", undefined, LIST_SHAPE],
  ])("rejects %s", async (_label, output, message) => {
    const { result } = await list(() => output);
    await expect(result).rejects.toThrow(message);
  });

  it("turns a failing subprocess into the login hint without its output", async () => {
    const { result } = await list(() => {
      throw new Error("private subprocess output");
    });
    await expect(result).rejects.toThrow(LIST_FAILED);
  });

  it.each(["readKeys", "writeRecords"] as const)(
    "refuses %s without running Wrangler",
    async (method) => {
      const { calls, run } = fakeWrangler();
      const refused = withWrangler(
        { accountId: ACCOUNT },
        async ({ kv }) =>
          method === "readKeys"
            ? kv(TARGET).readKeys(["user:a"])
            : kv(TARGET).writeRecords([{ key: "user:a", value: "{}" }]),
        { run, env: {} },
      );
      await expect(refused).rejects.toThrow(REFUSED);
      expect(calls).toEqual([]);
    },
  );

  it("rejects a malformed namespace id before running Wrangler", async () => {
    const { calls, run } = fakeWrangler();
    await expect(
      withWrangler({ accountId: ACCOUNT }, async ({ kv }) => kv("bad"), {
        run,
        env: {},
      }),
    ).rejects.toThrow(BAD_ID);
    expect(calls).toEqual([]);
  });
});

describe("withWrangler R2 store: latest.json", () => {
  it("accepts the exact latest.json key with the 1 MiB timeout", async () => {
    const { calls, run } = fakeWrangler(
      new Map([["latest.json", Buffer.from("{}")]]),
    );
    const bytes = await withWrangler(
      { accountId: ACCOUNT },
      async ({ r2 }) => r2(BUCKET).get("latest.json"),
      { run, env: {} },
    );
    expect(bytes.toString()).toBe("{}");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain(`${BUCKET}/latest.json`);
    expect(calls[0].timeout).toBe(122_000);
  });

  it.each(["other.json", "daily/latest.json", "latest.json.bak"])(
    "rejects %s as an object path without running Wrangler",
    async (key) => {
      const { calls, run } = fakeWrangler();
      await expect(
        withWrangler(
          { accountId: ACCOUNT },
          async ({ r2 }) => r2(BUCKET).get(key),
          { run, env: {} },
        ),
      ).rejects.toThrow(BAD_PATH);
      expect(calls).toEqual([]);
    },
  );
});

describe("kv-restore-drill main", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  function latestJson(overrides: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        manifestKey: MANIFEST_KEY,
        completedAt: COMPLETED_AT,
        sourceAccountId: ACCOUNT,
        sourceNamespaceId: SOURCE,
        ...overrides,
      }),
    );
  }

  function bucketObjects(latest: Buffer = latestJson()) {
    const { manifest, data } = seededArchive();
    const objects = new Map<string, Buffer>([
      ["latest.json", latest],
      [MANIFEST_KEY, Buffer.from(JSON.stringify(manifest))],
      [DATA_KEY, data],
    ]);
    return { manifest, objects };
  }

  async function drill(
    objects: Map<string, Buffer>,
    {
      config = localToml(),
      listed,
    }: { config?: string; listed?: () => unknown } = {},
  ) {
    const fake = fakeWrangler(objects, listed);
    const lines: string[] = [];
    const result = main([], {
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: "deploy" },
      run: fake.run,
      configPath: await writeConfig(config),
      log: (line) => lines.push(line),
    });
    return { ...fake, lines, result };
  }

  const trace = (calls: Call[]) =>
    calls.map((call) =>
      call.args[1] === "r2" ? `r2:${call.args[4]}` : `kv:${call.args[5]}`,
    );

  it("checks the latest backup against an empty drill namespace and prints the summary", async () => {
    const { manifest, objects } = bucketObjects();
    const { calls, lines, result } = await drill(objects);
    await result;
    expect(lines).toEqual([
      "檢查完成，尚未寫入：預計還原 10 筆；略過已到期或即將到期 0 筆。",
      `備份完成時間 ${manifest.completedAt}；筆數 ${manifest.count}；大小 ${manifest.byteLength} bytes；請求數（內部／對外）0／0。`,
      "請到 Healthchecks 的月度 dry-run 提醒 check 按 Ping Now，並把這次結果記進維運紀錄。",
    ]);
    expect(trace(calls)).toEqual([
      `r2:${BUCKET}/latest.json`,
      `r2:${BUCKET}/${MANIFEST_KEY}`,
      `r2:${BUCKET}/${DATA_KEY}`,
      `kv:${TARGET}`,
    ]);
    for (const call of calls) {
      expect([
        ["r2", "object", "get"],
        ["kv", "key", "list"],
      ]).toContainEqual(call.args.slice(1, 4));
      expect(call.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(call.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    }
  });

  it("prints completedAt as ISO, dropping parenthesised terminal escapes", async () => {
    const { manifest, objects } = bucketObjects();
    // Date.toString() layout: Date.parse skips the parenthesised part (Node 22
    // rejects trailing text after the ISO form, so validateArchive would fail).
    const completedAt =
      "Tue Oct 13 2026 03:17:00 GMT+0000 (\u001b[31mx\u001b[0m)";
    expect(Date.parse(completedAt)).toBe(NOW);
    objects.set(
      MANIFEST_KEY,
      Buffer.from(JSON.stringify({ ...manifest, completedAt })),
    );
    const { lines, result } = await drill(objects);
    await result;
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`備份完成時間 ${COMPLETED_AT}；`);
    for (const line of lines) {
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("(");
    }
  });

  it.each([
    [
      "a different source namespace",
      latestJson({ sourceNamespaceId: OTHER_ID }),
      "latest.json 的來源帳號或 namespace 與本機設定不符。",
    ],
    [
      "a different source account",
      latestJson({ sourceAccountId: OTHER_ID }),
      "latest.json 的來源帳號或 namespace 與本機設定不符。",
    ],
    ["an array", Buffer.from("[]"), "latest.json 格式不正確。"],
    ["null", Buffer.from("null"), "latest.json 格式不正確。"],
    ["text that is not JSON", Buffer.from("not json"), NOT_JSON],
    [
      "a manifestKey pointing at latest.json",
      latestJson({ manifestKey: "latest.json" }),
      BAD_PATH,
    ],
    [
      "a manifestKey pointing at the data object",
      latestJson({ manifestKey: DATA_KEY }),
      BAD_PATH,
    ],
  ])(
    "stops on a latest.json with %s before any other call",
    async (_label, latest, message) => {
      const { calls, lines, result } = await drill(
        bucketObjects(latest).objects,
      );
      await expect(result).rejects.toThrow(message);
      expect(trace(calls)).toEqual([`r2:${BUCKET}/latest.json`]);
      expect(lines).toEqual([]);
    },
  );

  it("refuses a drill namespace that is not empty", async () => {
    const { calls, lines, result } = await drill(bucketObjects().objects, {
      listed: () => ({ stdout: '[{"name":"user:x"}]', stderr: "" }),
    });
    await expect(result).rejects.toThrow(
      "目標 namespace 不是空白，沒有開始還原。",
    );
    expect(listCalls(calls)).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it("refuses a drill namespace equal to the source before downloading the backup", async () => {
    const { calls, lines, result } = await drill(bucketObjects().objects, {
      config: localToml({ drill: SOURCE }),
    });
    await expect(result).rejects.toThrow(
      "禁止寫入來源或正式 namespace，請建立新的隔離 namespace。",
    );
    expect(trace(calls)).toEqual([`r2:${BUCKET}/latest.json`]);
    expect(lines).toEqual([]);
  });

  it("prints the usage for --help without reading the config or running Wrangler", async () => {
    const run = vi.fn<WranglerRun>();
    const lines: string[] = [];
    await main(["--help"], {
      run,
      configPath: join(scratch, "absent.toml"),
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("用法");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([["--nope"], ["positional"], ["--apply"]])(
    "rejects the argument %s",
    async (argument) => {
      const run = vi.fn<WranglerRun>();
      await expect(main([argument], { run })).rejects.toThrow(
        "參數格式不正確，請使用 --help 查看用法。",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("reports a missing config file before running Wrangler", async () => {
    const run = vi.fn<WranglerRun>();
    await expect(
      main([], { run, configPath: join(scratch, "absent.toml") }),
    ).rejects.toThrow(MISSING_FILE);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("kv-restore-drill CLI process", () => {
  const script = resolve("../scripts/kv-restore-drill.mjs");

  it("prints the usage for --help without any environment", () => {
    const result = spawnSync(process.execPath, [script, "--help"], {
      encoding: "utf8",
      env: {},
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("用法");
  });

  it.skipIf(existsSync(resolve("wrangler.backup.local.toml")))(
    "exits 1 with the missing-config literal when no local config exists",
    () => {
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 10_000,
        env: {},
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "找不到 worker/wrangler.backup.local.toml",
      );
      expect(result.stderr).not.toMatch(/[0-9a-f]{32}/);
    },
  );
});
