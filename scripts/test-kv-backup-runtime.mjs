import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateArchive } from "./kv-backup/format.mjs";

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
const accountId = "a".repeat(32);
const namespaceId = "b".repeat(32);
const successUuid = "12345678-1234-1234-1234-123456789abc";
const capacityUuid = "87654321-4321-4321-4321-cba987654321";
const pings = [];
const source = `
import backup from ${JSON.stringify(join(root, "worker/src/backup/index.ts"))};
export default {
  scheduled: backup.scheduled,
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/seed') {
      const { key, value, metadata, expirationTtl } = await request.json();
      await env.BACKUP_KV.put(key, value, { metadata, expirationTtl });
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

function userValue(index) {
  const books = Array.from({ length: 115 }, (_, book) => ({
    bookId: String(210000000000 + index * 1000 + book),
    title: `合成書籍📚第${book}冊・家庭共讀`,
    isShared: book % 2,
  }));
  return JSON.stringify({ displayName: `家人${index}🐮`, books });
}

// ~500 synthetic records, about 5 MB; one pretty-printed value keeps its raw newlines.
function syntheticRecords() {
  const day = 24 * 60 * 60;
  const records = Array.from({ length: 480 }, (_, index) => ({
    key: `user:${String(index).padStart(32, "0")}`,
    value: userValue(index),
  }));
  for (let index = 0; index < 5; index++) {
    const family = `ab${index}c-d${index}ef`;
    const record = { ownerId: "0".repeat(32), members: ["0".repeat(32)] };
    records.push(
      {
        key: `family:${family}`,
        value: JSON.stringify(record, null, index === 0 ? 2 : undefined),
        metadata: index === 0 ? { note: "家庭" } : undefined,
      },
      { key: `member:${String(index).padStart(32, "1")}`, value: family },
    );
  }
  for (let index = 0; index < 3; index++)
    records.push({
      key: `borrows:family:ab${index}c-d${index}ef`,
      value: JSON.stringify([{ requestId: `r${index}`, status: "PENDING" }]),
    });
  const expiresAt = Date.now() + 30 * day * 1000;
  records.push(
    { key: "borrow:r1", value: JSON.stringify({ familyId: "ab0c-d0ef" }) },
    { key: "borrow:r2", value: JSON.stringify({ familyId: "ab1c-d1ef" }) },
    {
      key: "public:share-token",
      value: JSON.stringify({ expiresAt, books: [{ title: "公開書櫃✨" }] }),
      metadata: { kind: "public" },
      expirationTtl: 30 * day,
    },
    {
      key: `kicked:ab0c-d0ef:${"2".repeat(32)}`,
      value: JSON.stringify({ removedAt: Date.now(), removedBy: "0" }),
      metadata: { reason: "owner" },
      expirationTtl: 21600,
    },
    {
      key: `verify:${"3".repeat(32)}`,
      value: JSON.stringify({ method: "none" }),
    },
    { key: `publicshelves:${"3".repeat(32)}`, value: '{"shelves":[]}' },
    {
      key: `newbookdefault:${"3".repeat(32)}`,
      value: '{"newBookDefaultShared":1}',
    },
  );
  return records;
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
      SOURCE_ACCOUNT_ID: accountId,
      SOURCE_NAMESPACE_ID: namespaceId,
      HEALTHCHECKS_UUID: successUuid,
      HEALTHCHECKS_CAPACITY_UUID: capacityUuid,
    },
    outboundService: async (request) => {
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
  const records = syntheticRecords();
  const expected = new Map(records.map((record) => [record.key, record]));
  let rawBytes = 0;
  for (const record of records) {
    rawBytes += Buffer.byteLength(record.value);
    await (
      await fetchLocal("/seed", {
        method: "POST",
        body: JSON.stringify(record),
      })
    ).text();
  }
  for (const key of ["ratelimit:1.2.3.4:1", `otp:${"4".repeat(32)}`])
    await (
      await fetchLocal("/seed", {
        method: "POST",
        body: JSON.stringify({ key, value: "1" }),
      })
    ).text();
  assert(rawBytes > 4_000_000 && rawBytes < 6_000_000, `rawBytes=${rawBytes}`);
  console.log(
    `已準備 ${records.length} 筆合成資料；開始真實本機 scheduled 事件。`,
  );
  const started = performance.now();
  await (await fetchLocal("/cdn-cgi/local/scheduled?cron=17+3+*+*+*")).text();
  const elapsedMs = Math.round(performance.now() - started);
  assert.deepEqual(pings, [
    `https://hc-ping.com/${successUuid}`,
    `https://hc-ping.com/${capacityUuid}`,
  ]);
  const latest = await (await fetchLocal("/object?key=latest.json")).json();
  const manifest = await (
    await fetchLocal(`/object?key=${encodeURIComponent(latest.manifestKey)}`)
  ).json();
  assert.equal(manifest.version, 2);
  const data = Buffer.from(
    await (
      await fetchLocal(
        `/object?key=${encodeURIComponent(manifest.dataObjectPath)}`,
      )
    ).arrayBuffer(),
  );
  const restored = validateArchive(manifest, data, {
    accountId,
    namespaceId,
    manifestKey: latest.manifestKey,
  });
  assert.equal(restored.length, expected.size);
  for (const record of restored) {
    const original = expected.get(record.key);
    assert(original, "輸出含未知或重複 key");
    assert.equal(record.value, original.value, `value 不一致：${record.key}`);
    assert.deepEqual(record.metadata, original.metadata);
    assert.equal(record.expiration !== undefined, !!original.expirationTtl);
    expected.delete(record.key);
  }
  assert.equal(expected.size, 0);
  assert.equal(data.length, manifest.byteLength);
  assert(manifest.requests.internal < 100, "內部請求數超出預期");
  console.log(
    JSON.stringify({
      result: "PASS",
      count: restored.length,
      archiveBytes: data.length,
      internalRequests: manifest.requests.internal,
      externalRequests: pings.length,
      elapsedMs,
    }),
  );
  console.log(
    "本機演練不代表已驗證正式 Cloudflare 的 CPU 配額或 Email 投遞；內部請求數為 manifest 寫入前的計數。",
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
