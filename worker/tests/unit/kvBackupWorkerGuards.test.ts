import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** Bundles production into an in-memory copy before mutating it. The original
 * must pass, and removing either destructive/monitor guard must fail the same oracle. */
describe("Cloudflare backup guard mutation proofs", () => {
  it.each(["latest", "heartbeat"])(
    "detects removal of the %s guard",
    (kind) => {
      const run = (mutate: boolean) =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      const requireWorker=createRequire(${JSON.stringify(resolve("package.json"))});
      const requireWrangler=createRequire(requireWorker.resolve('wrangler/package.json'));
      const {buildSync}=requireWrangler('esbuild');
      let code=buildSync({entryPoints:[${JSON.stringify(resolve(`src/backup/${kind === "latest" ? "retention" : "heartbeat"}.ts`))}],bundle:true,platform:'node',format:'esm',write:false}).outputFiles[0].text;
      if (${mutate}) {
        const changed=${JSON.stringify(kind)}==='latest' ? code.replace('!protectedKeys.has(object.key) &&', '') : code.replace('new TextDecoder().decode(bytes) === "OK"', 'true');
        assert.notEqual(changed,code,'MUTATION_DID_NOT_LAND');code=changed;
      }
      const subject=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
      const now=Date.parse('2026-10-13T03:17:00Z');
      const budget={now:()=>now,check(){},call:fn=>fn(),sleep:async()=>{}};
      if (${JSON.stringify(kind)}==='latest') {
        const key='snapshots/2026-09-01/2026-09-01T03-17-00-000Z_12345678-1234-1234-1234-123456789abc.manifest.json';
        const deleted=[];
        const bucket={list:async()=>({objects:[{key,uploaded:new Date('2026-09-01')}],truncated:false}),get:async()=>({body:new Response(JSON.stringify({manifestKey:key,completedAt:'2026-09-01T03:18:00Z'})).body,etag:'old'}),delete:async keys=>deleted.push(...keys)};
        await subject.cleanOldSnapshots(bucket,budget);assert.deepEqual(deleted,[],'LATEST_WAS_DELETED');
      } else {
        await assert.rejects(subject.reportSuccess('12345678-1234-1234-1234-123456789abc',budget,async()=>new Response('fake success')),undefined,'FAKE_HEARTBEAT_ACCEPTED');
      }
    `,
          ],
          { encoding: "utf8", timeout: 15000 },
        );
      const baseline = run(false);
      expect(baseline.status, baseline.stderr).toBe(0);
      const mutant = run(true);
      expect(mutant.status, mutant.stderr).toBe(1);
      expect(mutant.stderr).toContain(
        kind === "latest" ? "LATEST_WAS_DELETED" : "FAKE_HEARTBEAT_ACCEPTED",
      );
    },
  );
});
