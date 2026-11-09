/**
 * The backup Worker's release-time deploy in `deploy-worker-prod`, read off
 * `.github/workflows/cicd.yml` and `worker/wrangler.backup.toml` as TEXT.
 *
 * WHY. The backup Worker refuses to run when it lists a key prefix its
 * allowlist (`scripts/kv-backup/format.mjs`) does not know. v1.8.0 added
 * `tokenidx:`; the API Worker shipped on the tag while the backup Worker stayed
 * on its old build, and every daily backup failed from 2026-11-04 until a
 * manual redeploy. `kvBackupKeyParity.test.ts` guards the repo sources only, so
 * the fix is a deploy ORDER: the backup Worker ships with every release, before
 * the API Worker (docs/kv-backup-plan.md §11). This file pins that wiring:
 *
 *   1. ORDER. The three steps (skip warning, deploy, secret check) exist in
 *      `deploy-worker-prod`, and the deploy and the secret check both run
 *      before "Deploy to Cloudflare (Prod)" — after it, the API would already
 *      be live writing a key family the deployed allowlist may not know.
 *   2. SWITCH. Repo variable `KV_BACKUP_DEPLOY` skips the two deploy-side
 *      steps only when it is `'false'` (`!=` on both), and the skip step is its
 *      exact complement (`==`) carrying a `::warning::`, so a skipped deploy is
 *      never silent. No `continue-on-error` anywhere in the job: a failed
 *      backup deploy must stop the API deploy (the user's chosen trade-off).
 *      Positive companion of that negative: the very same `jobBlock` string
 *      holds all three step headers, so a drifted job slice cannot pass it
 *      vacuously.
 *   3. SED, VERBATIM. The deploy step's `run` carries each of the four
 *      `-e` expressions in `SED_EXPRESSIONS` character for character.
 *   4. TEMPLATE FIT. The template carries exactly what those expressions
 *      rewrite — the whole `BACKUP_ENABLED = "false"` and `crons = []` lines,
 *      `YOUR_CLOUDFLARE_ACCOUNT_ID` once, `YOUR_PROD_KV_NAMESPACE_ID` twice —
 *      and no `YOUR_` name beyond those two plus
 *      `YOUR_EMPTY_DRILL_KV_NAMESPACE_ID` (positive companion: the de-duplicated
 *      `/YOUR_[A-Z_]+/g` hits are exactly those 3). Then the four expressions
 *      are applied in JS to the template with fake 32-hex ids, and only the
 *      `RESTORE_DRILL_NAMESPACE_ID` line may still carry `YOUR_` (the Worker
 *      never reads it), with `BACKUP_ENABLED = "true"` and the daily cron set.
 *      A sed that silently misses a placeholder would deploy fine and then fail
 *      every night, which is why this is simulated rather than trusted.
 *   5. SAME WORKER. The template's `name` and `bucket_name` stay those of the
 *      live backup Worker — a rename would make CI deploy a SECOND Worker whose
 *      cron races the first one for `latest.json`.
 *   6. SECRETS. The names the secret-check step requires equal the
 *      `env.HEALTHCHECKS_*` names `worker/src/backup/index.ts` reads (exactly
 *      2, de-duplicated) — taken from the source, so the list is never only
 *      written down in two places.
 *   7. NO TRACES. CD deploys the template as-is, so it is the live config:
 *      no non-comment line (trailing `#` comments cut) may name `traces` — a
 *      `[observability.traces]` header, a `traces = …` key or a dotted
 *      `observability.traces…` key alike. A fetch trace may record the full
 *      `https://hc-ping.com/<uuid>` URL, and the UUID lets anyone forge a
 *      "backup succeeded" ping (worker/DEPLOY.md → 步驟 3). Positive companion:
 *      the `[observability]` header is still followed by `enabled = true`.
 *
 * ONE SOURCE FOR POINTS 3 AND 4. `SED_EXPRESSIONS` holds the four expressions
 * as the shell sees them (quotes included). Point 3 asserts the workflow
 * contains them; point 4 derives its JS rewrite FROM them through
 * `parseSedExpression`, so editing the workflow's sed turns point 3 red first
 * instead of leaving a hand-written JS twin to agree with an outdated
 * constant. The parser is deliberately narrow and throws on anything it cannot
 * map faithfully: a double-quoted expression may only expand `${NAME}`
 * variables listed in `FAKE_ENV`; the pattern may hold only literal
 * characters, the `^` / `$` anchors and the escaped brackets `\[` / `\]` (which
 * mean the same in sed's BRE and in a JS RegExp); the replacement may hold no
 * `&` or `\`; the only flag is `g`. The rewrite is applied LINE BY LINE, like
 * sed: `^` / `$` anchor each line, and without `g` only the first hit per line
 * is replaced. The replacement is passed as a function, so JS's `$&`-style
 * patterns cannot alter it.
 *
 * MUTATION-CHECK SEAMS. `MOO_CI_WORKFLOW_PATH` (same name as
 * `ciSuccessGate.test.ts`) and `MOO_BACKUP_TEMPLATE_PATH` point the reads at
 * throwaway COPIES, so these guards can be driven red at authoring time
 * without editing the live files. CI sets neither. Both defaults resolve from
 * THIS file, not `process.cwd()`, and a path that does not exist throws (the
 * workflow through `readWorkflow`, the template through `readRequiredText`).
 * `worker/src/backup/index.ts` has no seam on purpose: point 6 is mutated
 * through the workflow copy.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  jobBlock,
  jobSteps,
  namedStep,
  readWorkflow,
  stepIndexNamed,
  stepRun,
} from "../helpers/workflowText";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mutation-check seams (CI sets none), resolved from THIS file, not the cwd.
// See the header → "MUTATION-CHECK SEAMS".
const WORKFLOW_PATH =
  process.env.MOO_CI_WORKFLOW_PATH ??
  resolve(HERE, "../../../.github/workflows/cicd.yml");
const TEMPLATE_PATH =
  process.env.MOO_BACKUP_TEMPLATE_PATH ??
  resolve(HERE, "../../wrangler.backup.toml");
const BACKUP_SOURCE_PATH = resolve(HERE, "../../src/backup/index.ts");

const JOB_ID = "deploy-worker-prod";
const SKIP_STEP = "Skip backup Worker deploy (KV_BACKUP_DEPLOY=false)";
const DEPLOY_STEP = "Deploy backup Worker (Prod)";
const VERIFY_STEP = "Verify backup Worker secrets";
const API_DEPLOY_STEP = "Deploy to Cloudflare (Prod)";

// The four sed expressions exactly as the shell sees them; point 4's JS rewrite is derived from these.
// See the header → "ONE SOURCE FOR POINTS 3 AND 4".
const SED_EXPRESSIONS = [
  `'s/^BACKUP_ENABLED = "false"$/BACKUP_ENABLED = "true"/'`,
  `"s/YOUR_CLOUDFLARE_ACCOUNT_ID/\${CLOUDFLARE_ACCOUNT_ID}/"`,
  `"s/YOUR_PROD_KV_NAMESPACE_ID/\${KV_NAMESPACE_ID_PROD}/g"`,
  `'s/^crons = \\[\\]$/crons = ["17 3 * * *"]/'`,
] as const;

/** Fake secret values for the simulation — 32 lowercase hex, like the step's own format check. */
const FAKE_ENV: Readonly<Record<string, string>> = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  KV_NAMESPACE_ID_PROD: "fedcba9876543210fedcba9876543210",
};

const DAILY_CRON_LINE = 'crons = ["17 3 * * *"]';
const DRILL_NAMESPACE_KEY = "RESTORE_DRILL_NAMESPACE_ID";
const EXPECTED_PLACEHOLDERS = [
  "YOUR_CLOUDFLARE_ACCOUNT_ID",
  "YOUR_EMPTY_DRILL_KV_NAMESPACE_ID",
  "YOUR_PROD_KV_NAMESPACE_ID",
];

/** Reads a required file as UTF-8, CRLF-normalised; throws loudly when absent. */
function readRequiredText(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${label} not found at ${path} — fix the path instead of letting the ` +
        `assertions pass over an empty read.`,
    );
  }
  return readFileSync(path, "utf8").split("\r\n").join("\n");
}

/** One parsed `s/pattern/replacement/flags` expression, ready to apply per line. */
interface SedRewrite {
  pattern: RegExp;
  replacement: string;
}

/** Parses one shell-quoted sed `s` expression; throws on anything it cannot map faithfully. */
function parseSedExpression(quoted: string): SedRewrite {
  const quote = quoted[0];
  if ((quote !== "'" && quote !== '"') || !quoted.endsWith(quote)) {
    throw new Error(`Not a single- or double-quoted expression: ${quoted}`);
  }
  let body = quoted.slice(1, -1);
  if (quote === '"') {
    body = body.replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => {
      const value = FAKE_ENV[name];
      if (value === undefined) {
        throw new Error(`No fake value for \${${name}} in ${quoted}`);
      }
      return value;
    });
  }
  const parts = /^s\/((?:\\.|[^\\/])*)\/((?:\\.|[^\\/])*)\/(g?)$/.exec(body);
  if (!parts) {
    throw new Error(
      `Not a plain s/pattern/replacement/[g] expression: ${quoted}`,
    );
  }
  const [, pattern, replacement, flags] = parts;
  if (!/^(?:[A-Za-z0-9_ ="^$]|\\\[|\\\])*$/.test(pattern)) {
    throw new Error(
      `Pattern needs more than a literal-string mapping: ${pattern}`,
    );
  }
  if (/[&\\]/.test(replacement)) {
    throw new Error(`Replacement uses sed-special characters: ${replacement}`);
  }
  return { pattern: new RegExp(pattern, flags), replacement };
}

/** Applies the rewrites line by line, in order, like `sed -e … -e …`. */
function applySed(text: string, rewrites: readonly SedRewrite[]): string {
  return text
    .split("\n")
    .map((line) =>
      rewrites.reduce(
        (current, { pattern, replacement }) =>
          current.replace(pattern, () => replacement),
        line,
      ),
    )
    .join("\n");
}

/** How many times `needle` occurs in `haystack`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Non-comment template lines (trailing `#` comments cut) that name a `traces` setting. */
function tracesSettingLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s#.*$/, "").trim())
    .filter((line) => !line.startsWith("#") && /\btraces\b/.test(line));
}

/** The quoted names of the `[...].filter(` array in the secret-check step's `node -e`. */
function requiredSecretNames(run: string): string[] {
  const list = /\[([^\]]*)\]\.filter\(/.exec(run);
  if (!list) {
    throw new Error(
      `\`${VERIFY_STEP}\` has no \`[...].filter(\` list of required secret names.`,
    );
  }
  return [...list[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

const WORKFLOW = readWorkflow(WORKFLOW_PATH);
const TEMPLATE = readRequiredText(TEMPLATE_PATH, "Backup Worker template");
const PROD_BLOCK = jobBlock(WORKFLOW, JOB_ID);
const PROD_STEPS = jobSteps(PROD_BLOCK, JOB_ID);

describe("deploy-worker-prod backup Worker steps", () => {
  it("has the skip, deploy and secret-check steps, both deploy-side ones before the API deploy", () => {
    for (const name of [SKIP_STEP, DEPLOY_STEP, VERIFY_STEP]) {
      expect(namedStep(WORKFLOW, JOB_ID, name)).toContain(`- name: ${name}`);
    }
    const apiIndex = stepIndexNamed(PROD_STEPS, API_DEPLOY_STEP);
    expect(stepIndexNamed(PROD_STEPS, DEPLOY_STEP)).toBeLessThan(apiIndex);
    expect(stepIndexNamed(PROD_STEPS, VERIFY_STEP)).toBeLessThan(apiIndex);
  });

  it.each([DEPLOY_STEP, VERIFY_STEP])(
    "runs %s unless KV_BACKUP_DEPLOY is 'false'",
    (name) => {
      expect(namedStep(WORKFLOW, JOB_ID, name)).toMatch(
        /^ {8}if:[ \t]*\$\{\{[ \t]*vars\.KV_BACKUP_DEPLOY[ \t]*!=[ \t]*'false'[ \t]*\}\}[ \t]*$/m,
      );
    },
  );

  it("warns, only when KV_BACKUP_DEPLOY is 'false', that the backup Worker was skipped", () => {
    const step = namedStep(WORKFLOW, JOB_ID, SKIP_STEP);
    expect(step).toMatch(
      /^ {8}if:[ \t]*\$\{\{[ \t]*vars\.KV_BACKUP_DEPLOY[ \t]*==[ \t]*'false'[ \t]*\}\}[ \t]*$/m,
    );
    expect(stepRun(step, SKIP_STEP)).toContain("::warning::");
  });

  it("never lets a failed backup step pass with continue-on-error", () => {
    // A failed backup deploy must stop the API deploy. See the header → point 2.
    expect(PROD_BLOCK).not.toContain("continue-on-error");
  });

  it("reads the same job block the steps were found in", () => {
    // Positive companion of the negative above: the slice it scanned holds all three steps.
    for (const name of [SKIP_STEP, DEPLOY_STEP, VERIFY_STEP]) {
      expect(PROD_BLOCK).toContain(`      - name: ${name}\n`);
    }
  });

  it.each(SED_EXPRESSIONS)("rewrites the template with -e %s", (expression) => {
    const run = stepRun(namedStep(WORKFLOW, JOB_ID, DEPLOY_STEP), DEPLOY_STEP);
    expect(run).toContain(`-e ${expression}`);
  });

  it("checks for exactly the Healthchecks secrets the backup Worker reads", () => {
    // Names come from the Worker source, never only from this file. See the header → point 6.
    const source = readRequiredText(BACKUP_SOURCE_PATH, "Backup Worker source");
    const read = [
      ...new Set(
        [...source.matchAll(/env\.(HEALTHCHECKS_[A-Z_]+)/g)].map((m) => m[1]),
      ),
    ].sort();
    expect(read).toHaveLength(2);
    const run = stepRun(namedStep(WORKFLOW, JOB_ID, VERIFY_STEP), VERIFY_STEP);
    expect([...requiredSecretNames(run)].sort()).toEqual(read);
  });
});

describe("wrangler.backup.toml as the CD deploy's input", () => {
  it("keeps the disabled lines and the placeholders the sed expressions rewrite", () => {
    expect(TEMPLATE).toMatch(/^BACKUP_ENABLED = "false"$/m);
    expect(TEMPLATE).toMatch(/^crons = \[\]$/m);
    expect(countOf(TEMPLATE, "YOUR_CLOUDFLARE_ACCOUNT_ID")).toBe(1);
    expect(countOf(TEMPLATE, "YOUR_PROD_KV_NAMESPACE_ID")).toBe(2);
    const names = [...new Set(TEMPLATE.match(/YOUR_[A-Z_]+/g) ?? [])].sort();
    expect(names).toEqual(EXPECTED_PLACEHOLDERS);
  });

  it("leaves only the drill namespace placeholder once the CD rewrite is applied", () => {
    // The JS rewrite is derived from SED_EXPRESSIONS, line by line like sed.
    // See the header → "ONE SOURCE FOR POINTS 3 AND 4".
    const deployed = applySed(
      TEMPLATE,
      SED_EXPRESSIONS.map(parseSedExpression),
    );
    const leftover = deployed
      .split("\n")
      .filter((line) => line.includes("YOUR_"));
    expect(leftover).toHaveLength(1);
    expect(leftover[0]).toContain(DRILL_NAMESPACE_KEY);
    expect(deployed).toMatch(/^BACKUP_ENABLED = "true"$/m);
    expect(deployed).toContain(DAILY_CRON_LINE);
    expect(countOf(deployed, FAKE_ENV.CLOUDFLARE_ACCOUNT_ID)).toBe(1);
    expect(countOf(deployed, FAKE_ENV.KV_NAMESPACE_ID_PROD)).toBe(2);
  });

  it("deploys the same backup Worker and bucket as the live one", () => {
    // A rename would deploy a SECOND Worker racing the first for latest.json. See the header → point 5.
    expect(TEMPLATE).toMatch(/^name = "moo-family-bookshelf-backup"$/m);
    expect(TEMPLATE).toMatch(/^bucket_name = "moo-family-bookshelf-backups"$/m);
  });

  it("never turns on Workers traces for the backup Worker", () => {
    // A fetch trace may record the secret hc-ping.com/<uuid> URL (worker/DEPLOY.md → 步驟 3).
    // See the header → point 7.
    expect(TEMPLATE).toMatch(/^\[observability\]\nenabled = true$/m);
    expect(tracesSettingLines(TEMPLATE)).toEqual([]);
  });
});
