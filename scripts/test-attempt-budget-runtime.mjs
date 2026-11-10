import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the real AttemptBudgetObject in local workerd (SQLite storage); no credentials, no remote data.
// The object exposes no counter read, so every route infers the count from later reservations.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireWorker = createRequire(join(root, "worker/package.json"));
const requireWrangler = createRequire(
  requireWorker.resolve("wrangler/package.json"),
);
const { build } = requireWrangler("esbuild");
const { Miniflare, convertV4MiniflareOptions } = requireWrangler("miniflare");
const directory = await mkdtemp(join(tmpdir(), "moo-attempt-budget-"));
let runtime;

const objectPath = join(root, "worker/src/durable/attemptBudgetObject.ts");
const source = `
export { AttemptBudgetObject } from ${JSON.stringify(objectPath)};

const WINDOW = 3600;
const stub = (env, name) => env.ATTEMPT_BUDGET.get(env.ATTEMPT_BUDGET.idFromName(name));
const tag = (result) => (result.admitted ? "admitted" : "refused");

async function burst(env) {
  const results = await Promise.all(
    Array.from({ length: 50 }, () => stub(env, "burst").reserve(10, WINDOW)),
  );
  const admitted = results.filter((result) => result.admitted);
  return [
    admitted.length,
    results.length - admitted.length,
    admitted.every((result) => result.epoch === 0),
  ];
}

async function refund(env) {
  const budget = stub(env, "refund");
  const out = [];
  const first = await budget.reserve(3, WINDOW);
  out.push(tag(first));
  out.push(tag(await budget.reserve(3, WINDOW)));
  out.push(tag(await budget.reserve(3, WINDOW)));
  out.push(tag(await budget.reserve(3, WINDOW)));
  await budget.refund(first.bucket + 1, first.epoch);
  out.push(tag(await budget.reserve(3, WINDOW)));
  await budget.refund(first.bucket, first.epoch + 1);
  out.push(tag(await budget.reserve(3, WINDOW)));
  await budget.refund(first.bucket, first.epoch);
  out.push(tag(await budget.reserve(3, WINDOW)));
  out.push(tag(await budget.reserve(3, WINDOW)));
  return out;
}

async function resetRace(env) {
  const budget = stub(env, "reset");
  const out = [];
  const old = await budget.reserve(3, WINDOW);
  out.push(tag(old));
  await budget.reset(WINDOW);
  for (let i = 0; i < 3; i++) out.push(tag(await budget.reserve(3, WINDOW)));
  await budget.refund(old.bucket, old.epoch);
  out.push(tag(await budget.reserve(3, WINDOW)));
  return out;
}

async function resetEmpty(env) {
  const budget = stub(env, "empty");
  await budget.reset(WINDOW);
  const out = [];
  for (let i = 0; i < 4; i++) out.push(tag(await budget.reserve(3, WINDOW)));
  return out;
}

async function isolation(env) {
  const a = stub(env, "iso-a");
  const out = [];
  for (let i = 0; i < 4; i++) out.push(tag(await a.reserve(3, WINDOW)));
  out.push(tag(await stub(env, "iso-b").reserve(3, WINDOW)));
  return out;
}

const routes = {
  "/burst": burst,
  "/refund": refund,
  "/reset-race": resetRace,
  "/reset-empty": resetEmpty,
  "/isolation": isolation,
};

export default {
  async fetch(request, env) {
    const route = routes[new URL(request.url).pathname];
    if (!route) return new Response("unknown route", { status: 404 });
    return Response.json(await route(env));
  },
};`;

const expected = {
  "/burst": [10, 40, true],
  "/refund": [
    "admitted",
    "admitted",
    "admitted",
    "refused",
    "refused",
    "refused",
    "admitted",
    "refused",
  ],
  "/reset-race": ["admitted", "admitted", "admitted", "admitted", "refused"],
  "/reset-empty": ["admitted", "admitted", "admitted", "refused"],
  "/isolation": ["admitted", "admitted", "admitted", "refused", "admitted"],
};

let failed = false;
try {
  const config = await readFile(join(root, "worker/wrangler.toml"), "utf8");
  const compatibilityDate = config.match(
    /^compatibility_date = "([^"]+)"/m,
  )?.[1];
  assert(compatibilityDate, "worker/wrangler.toml 沒有 compatibility_date");

  const scriptPath = join(directory, "harness.mjs");
  await build({
    stdin: { contents: source, resolveDir: root, loader: "ts" },
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers"],
    outfile: scriptPath,
  });

  const options = convertV4MiniflareOptions({
    modules: true,
    scriptPath,
    compatibilityDate,
    durableObjects: {
      ATTEMPT_BUDGET: { className: "AttemptBudgetObject", useSQLite: true },
    },
  });
  options.telemetry = { enabled: false };
  options.resourceTmpPath = directory;
  runtime = new Miniflare(options);
  await runtime.ready;

  for (const [path, want] of Object.entries(expected)) {
    const response = await runtime.dispatchFetch(`http://localhost${path}`);
    assert.equal(response.status, 200, `本機請求失敗：${path}`);
    const got = await response.json();
    const pass = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${pass ? "PASS" : "FAIL"} ${path} ${JSON.stringify(got)}`);
    if (!pass) {
      console.log(`  預期 ${JSON.stringify(want)}`);
      failed = true;
    }
  }
  console.log(
    `compatibility_date ${compatibilityDate}；本機演練不代表已驗證正式 Cloudflare 的延遲或額度。`,
  );
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await runtime?.dispose();
  const resolved = resolve(directory);
  assert(
    resolved.startsWith(
      resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
    ) && resolved.includes("moo-attempt-budget-"),
  );
  await rm(resolved, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
