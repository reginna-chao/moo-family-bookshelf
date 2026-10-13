import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Executes the real scheduled handler in local workerd; no remote credentials or data.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireWorker = createRequire(join(root, "worker/package.json"));
const requireWrangler = createRequire(
  requireWorker.resolve("wrangler/package.json"),
);
const { build } = requireWrangler("esbuild");
const {
  Miniflare,
  Response: LocalResponse,
  convertV4MiniflareOptions,
} = requireWrangler("miniflare");
const directory = await mkdtemp(join(tmpdir(), "moo-backup-runtime-"));
let runtime;
const expected = new Map();
const pings = [];
const uuid = "12345678-1234-1234-1234-123456789abc";
const source = `
import backup from ${JSON.stringify(join(root, "worker/src/backup/index.ts"))};
export default {
  scheduled: backup.scheduled,
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/seed') {
      const record = await request.json();
      await env.BACKUP_KV.put(record.key, record.value, {metadata: record.metadata});
      return new Response('seeded');
    }
    if (url.pathname === '/object') {
      const object = await env.BACKUP_BUCKET.get(url.searchParams.get('key'));
      return object ? new Response(object.body) : new Response('missing',{status:404});
    }
    return backup.fetch();
  }
};`;

async function fetchLocal(path, init) {
  const response = await runtime.dispatchFetch(`http://localhost${path}`, init);
  assert.equal(response.status, 200, `本機請求失敗：${path}`);
  return response;
}

try {
  const config = await readFile(
    join(root, "worker/wrangler.backup.toml"),
    "utf8",
  );
  const compatibilityDate = config.match(
    /^compatibility_date = "([^"]+)"/m,
  )?.[1];
  const compatibilityFlags = JSON.parse(
    config.match(/^compatibility_flags = (\[[^\n]+\])/m)?.[1] ?? "[]",
  );
  assert(compatibilityDate);
  const output = await build({
    stdin: { contents: source, resolveDir: root, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    write: false,
  });
  const options = convertV4MiniflareOptions({
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate,
    compatibilityFlags,
    cf: false,
    unsafeTriggerHandlers: true,
    kvNamespaces: ["BACKUP_KV"],
    r2Buckets: ["BACKUP_BUCKET"],
    bindings: {
      BACKUP_ENABLED: "true",
      SOURCE_ACCOUNT_ID: "a".repeat(32),
      SOURCE_NAMESPACE_ID: "b".repeat(32),
      HEALTHCHECKS_UUID: uuid,
    },
    outboundService: async (request) => {
      assert.equal(request.url, `https://hc-ping.com/${uuid}`);
      assert.equal(request.method, "POST");
      assert.equal(await request.text(), "");
      pings.push(request.url);
      return new LocalResponse("OK");
    },
  });
  options.telemetry = { enabled: false };
  options.resourceTmpPath = directory;
  runtime = new Miniflare(options);
  await runtime.ready;
  let rawBytes = 0;
  for (let index = 0; index < 501; index++) {
    const note =
      index === 500
        ? "\\t".repeat((4 * 1024 * 1024 - 12) / 2)
        : "x".repeat(100000);
    const value =
      index === 500
        ? '{"note":"' + note + ' "}'
        : JSON.stringify({ books: [], note, title: "合成書籍📚" });
    if (index === 500) assert.equal(Buffer.byteLength(value), 4 * 1024 * 1024);
    const key = `user:synthetic-${index}`;
    const metadata = { fixture: index };
    rawBytes += Buffer.byteLength(value);
    expected.set(key, {
      sha256: createHash("sha256").update(value).digest("hex"),
      metadata,
    });
    await (
      await fetchLocal("/seed", {
        method: "POST",
        body: JSON.stringify({ key, value, metadata }),
      })
    ).text();
  }
  assert(rawBytes >= 50_000_000);
  console.log("已準備 501 筆合成資料；開始真實本機 scheduled 事件。");
  const started = performance.now();
  await (await fetchLocal("/cdn-cgi/local/scheduled?cron=17+3+*+*+*")).text();
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(pings.length, 1);
  const latest = await (await fetchLocal("/object?key=latest.json")).json();
  const manifest = await (
    await fetchLocal(`/object?key=${encodeURIComponent(latest.manifestKey)}`)
  ).json();
  assert.equal(manifest.count, expected.size);
  const response = await fetchLocal(
    `/object?key=${encodeURIComponent(manifest.dataObjectPath)}`,
  );
  const hash = createHash("sha256");
  let archiveBytes = 0;
  let partial = "";
  let count = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of response.body) {
    archiveBytes += chunk.byteLength;
    hash.update(chunk);
    partial += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = partial.indexOf("\n")) !== -1) {
      const record = JSON.parse(partial.slice(0, newline));
      partial = partial.slice(newline + 1);
      const original = expected.get(record.key);
      assert(original, "輸出含未知或重複 key");
      assert.equal(
        createHash("sha256").update(record.value).digest("hex"),
        original.sha256,
      );
      assert.deepEqual(record.metadata, original.metadata);
      expected.delete(record.key);
      count++;
    }
  }
  partial += decoder.decode();
  assert.equal(partial, "");
  assert.equal(expected.size, 0);
  assert.equal(archiveBytes, manifest.byteLength);
  assert.equal(hash.digest("hex"), manifest.sha256);
  console.log(
    JSON.stringify({
      result: "PASS",
      runtime: "local workerd",
      count,
      rawBytes,
      archiveBytes,
      elapsedMs,
      heartbeatCount: pings.length,
      largestRawRecordBytes: 4 * 1024 * 1024,
    }),
  );
  console.log(
    "本機演練不代表已驗證正式 Cloudflare 的 CPU／記憶體配額或 Email 投遞。",
  );
} finally {
  await runtime?.dispose();
  const resolved = resolve(directory);
  assert(
    resolved.startsWith(
      resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
    ) && resolved.includes("moo-backup-runtime-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
