import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withR2Store } from "../../../scripts/kv-backup/storage.mjs";
import {
  ACCOUNT,
  SOURCE,
  TARGET,
  DATA_KEY,
  MANIFEST_KEY,
} from "../helpers/kvBackupFixtures";

/** Runs the real temporary-file adapter with a subprocess seam, asserting
 * its actual files and credentials. CLI checks spawn Node with no network. */
describe("R2 storage and CLI boundaries", () => {
  it.each([false, true])(
    "isolates credentials and removes temporary files (failure=%s)",
    async (fail) => {
      let directory = "";
      const run: NonNullable<
        NonNullable<Parameters<typeof withR2Store>[2]>["run"]
      > = async (file, args, options) => {
        directory = options.cwd;
        expect(file).toBe(process.execPath);
        expect(args).toContain("--remote");
        expect(args).toContain("--config");
        expect(options.windowsHide).toBe(true);
        expect(options.env.KV_BACKUP_API_TOKEN).toBeUndefined();
        expect(options.env.KV_RESTORE_API_TOKEN).toBeUndefined();
        expect(options.env.CF_API_KEY).toBeUndefined();
        expect(options.env.CLOUDFLARE_API_TOKEN).toBe("r2-only");
        expect(options.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
        const local = args[args.indexOf("--file") + 1];
        if (fail) throw new Error("private subprocess output");
        if (args.includes("put"))
          expect((await readFile(local)).toString()).toBe("archive");
        else await writeFile(local, "archive");
        return { stdout: "", stderr: "" };
      };
      const transfer = withR2Store(
        { accountId: ACCOUNT, bucket: "backup-bucket", token: "r2-only" },
        async (store) => {
          await store.put(DATA_KEY, Buffer.from("archive"));
          expect((await store.get(DATA_KEY)).toString()).toBe("archive");
        },
        {
          run,
          env: {
            PATH: process.env.PATH,
            KV_BACKUP_API_TOKEN: "kv-read",
            KV_RESTORE_API_TOKEN: "kv-write",
            CF_API_KEY: "global",
            CLOUDFLARE_API_TOKEN: "deploy",
          },
        },
      );
      if (fail) await expect(transfer).rejects.toThrow("R2 傳輸失敗");
      else await transfer;
      expect(directory).not.toBe("");
      expect(existsSync(directory)).toBe(false);
    },
  );

  const MiB = 1024 * 1024;
  const timeoutFor = (bytes: number) =>
    120_000 + 2_000 * Math.ceil(bytes / MiB);

  async function recordTimeouts(action: Parameters<typeof withR2Store>[1]) {
    const timeouts: number[] = [];
    await withR2Store(
      { accountId: ACCOUNT, bucket: "backup-bucket", token: "r2-only" },
      action,
      {
        run: async (_file, _args, options) => {
          timeouts.push(options.timeout);
          return { stdout: "", stderr: "" };
        },
        env: { PATH: process.env.PATH },
      },
    );
    return timeouts;
  }

  it.each([
    [0, 120_000],
    [7, 122_000],
    [MiB, 122_000],
    [MiB + 1, 124_000],
  ])(
    "gives a put of %i bytes a child-process timeout of %i ms",
    async (bytes, expected) => {
      expect(timeoutFor(bytes)).toBe(expected);
      const timeouts = await recordTimeouts((store) =>
        store.put(DATA_KEY, Buffer.alloc(bytes, 1)),
      );
      expect(timeouts).toEqual([expected]);
    },
  );

  it.each([
    [MANIFEST_KEY, 1, 122_000],
    [DATA_KEY, 256, 632_000],
  ])(
    "scales the timeout of a get of %s to its %i MiB download limit",
    async (key, limitMiB, expected) => {
      expect(timeoutFor(limitMiB * MiB)).toBe(expected);
      const timeouts = await recordTimeouts(async (store) => {
        await store.get(key);
      });
      expect(timeouts).toEqual([expected]);
    },
  );

  it.each(["kv-backup", "kv-restore"])(
    "runs the real %s --help without credentials",
    (name) => {
      const result = spawnSync(
        process.execPath,
        [resolve("../scripts", `${name}.mjs`), "--help"],
        { encoding: "utf8", env: {} },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("用法");
    },
  );

  it("rejects non-interactive apply before connecting to any service", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve("../scripts/kv-restore.mjs"),
        "--backup",
        MANIFEST_KEY,
        "--target-namespace",
        TARGET,
        "--apply",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          KV_BACKUP_NAMESPACE_ID: SOURCE,
          KV_BACKUP_API_TOKEN: "read",
          KV_RESTORE_API_TOKEN: "write",
          KV_BACKUP_BUCKET: "backup-bucket",
          KV_BACKUP_R2_API_TOKEN: "r2",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/互動|終端/);
    expect(result.stderr).not.toContain("r2");
  });

  it("keeps the Cloudflare backup disabled until explicit activation", () => {
    const config = readFileSync(resolve("wrangler.backup.toml"), "utf8");
    expect(config).toContain('BACKUP_ENABLED = "false"');
    expect(config).toMatch(/^crons = \[\]$/m);
    expect(config).toContain('main = "src/backup/index.ts"');
    expect(config).toContain('binding = "BACKUP_KV"');
    expect(config).toContain('binding = "BACKUP_BUCKET"');
    expect(config).toContain("workers_dev = false");
    expect(config).toContain("preview_urls = false");
    expect(existsSync(resolve("../.github/workflows/kv-backup.yml"))).toBe(
      false,
    );
  });

  it.each(["dry-run", "manifest"])(
    "proves the %s guard fails when removed from an in-memory copy",
    (guard) => {
      const formatUrl = pathToFileURL(
        resolve("../scripts/kv-backup/format.mjs"),
      ).href;
      const source = readFileSync(
        resolve(
          `../scripts/kv-backup/${guard === "dry-run" ? "restore" : "backup"}.mjs`,
        ),
        "utf8",
      ).replace('"./format.mjs"', JSON.stringify(formatUrl));
      const mutant =
        guard === "dry-run"
          ? source.replace("if (!apply)", "if (false && !apply)")
          : source.replace(
              "validateArchive(manifest, downloaded, {",
              "((..._args) => {})(manifest, downloaded, {",
            );
      expect(mutant).not.toBe(source);
      const program = (code: string) => `
      import assert from 'node:assert/strict';
      import { createArchive } from ${JSON.stringify(formatUrl)};
      const subject = await import('data:text/javascript;base64,' + Buffer.from(${JSON.stringify(code)}).toString('base64'));
      const record = { key: 'user:fixture', value: '{}' };
      const accountId = ${JSON.stringify(ACCOUNT)}, namespaceId = ${JSON.stringify(SOURCE)};
      const now = () => Date.parse('2026-10-13T03:17:00Z');
      const { data, manifest } = createArchive([record], { accountId, namespaceId, startedAt: new Date(now()).toISOString(), completedAt: new Date(now()).toISOString(), objectKey: ${JSON.stringify(DATA_KEY)} });
      let writes = 0;
      const client = { listKeys: async () => [], readKeys: async () => ({ [record.key]: { value: record.value } }), writeRecords: async () => { writes++; } };
      const store = { get: async key => key.endsWith('.manifest.json') ? Buffer.from(JSON.stringify(manifest)) : data, put: async () => {} };
      if (${JSON.stringify(guard)} === 'dry-run') {
        await subject.runRestore({ client, store, accountId, sourceNamespaceId: namespaceId, targetNamespaceId: ${JSON.stringify(TARGET)}, manifestKey: ${JSON.stringify(MANIFEST_KEY)}, now, confirm: async () => true });
        assert.equal(writes, 0, 'DRY_RUN_WROTE');
      } else {
        client.listKeys = async () => [{ name: record.key }];
        store.get = async () => Buffer.from('truncated');
        await assert.rejects(subject.runBackup({ client, store, accountId, namespaceId, now, uuid: () => '12345678-1234-1234-1234-123456789abc' }), undefined, 'CORRUPTION_ACCEPTED');
      }
    `;
      const baseline = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", program(source)],
        { encoding: "utf8" },
      );
      expect(baseline.status, baseline.stderr).toBe(0);
      const changed = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", program(mutant)],
        { encoding: "utf8" },
      );
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain(
        guard === "dry-run" ? "DRY_RUN_WROTE" : "CORRUPTION_ACCEPTED",
      );
    },
  );
});
