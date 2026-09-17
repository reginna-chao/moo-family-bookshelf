/**
 * The CI gate, read straight off `.github/workflows/cicd.yml` as TEXT.
 *
 * WHY A TEST READS A WORKFLOW FILE. The repository ruleset `main-protection`
 * makes `CI Success` the SOLE required status check, so the `ci-success` job's
 * `needs` list is the complete definition of "CI passed". Nothing else in the
 * repo observes that list: every check job keeps working when it is dropped
 * from the gate, and a pull request merges green.
 *
 * The concrete failure this pins (the bug that prompted the file): `changes`
 * is the path-filter job every check job's `if:` reads
 * (`needs.changes.outputs.<pkg> == 'true'`). When `changes` FAILS its outputs
 * are empty, that comparison is false, and each check job is SKIPPED rather
 * than failed. `ci-success` looks only for `failure` / `cancelled`, so with
 * `changes` absent from its `needs` and from its `results` string the gate saw
 * five `skipped` results and exited 0 — a vacuously green required check with
 * zero lint, typecheck, test or E2E jobs having run.
 *
 * HOW IT AVOIDS PASSING VACUOUSLY. The scan is parsed out of the file by
 * regex, so a drifted pattern (or a moved file) could match nothing and make
 * every "is in the gate" assertion trivially true over an empty job list.
 * Three things stop that: the path is resolved relative to THIS file and its
 * existence is asserted, every helper throws when its anchor is missing
 * instead of returning an empty result, and the positive companion below pins
 * the job ids the scan must find — the six CI jobs plus two CD jobs.
 *
 * FAIL-CLOSED BY DESIGN. A future job that is neither `ci-success` nor
 * `deploy-*` / `release-*` counts as a CI job and must be added to the gate.
 * A new pipeline stage under a different naming convention goes RED here; that
 * forces a deliberate decision about whether it belongs in the required check.
 * There is no escape hatch on purpose.
 *
 * No YAML library is used: neither `yaml` nor `js-yaml` is resolvable in this
 * workspace, and a new dependency is a non-goal (`.claude/rules/change-triage.md`).
 * Same grep-shaped house style as `worker/tests/unit/kvAccessBoundary.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved from THIS file, not `process.cwd()`: vitest runs with the `worker/`
 * package as its cwd, and the workflow sits two levels above it.
 */
const WORKFLOW_PATH = resolve(HERE, "../../../.github/workflows/cicd.yml");

/** The aggregate gate itself — required status check, never its own dependency. */
const GATE_JOB_ID = "ci-success";

/** Job-id prefixes that are CD, and correctly sit outside the CI gate. */
const CD_JOB_PREFIXES = ["deploy-", "release-"];

// ===========================================================================
// A minimal, anchor-checked workflow reader
// ===========================================================================

/** Reads the workflow as UTF-8, CRLF-normalised; throws loudly when absent. */
function readWorkflow(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `CI workflow not found at ${path}. This guard is only meaningful while ` +
        `it reads the real file — update the path instead of letting the ` +
        `assertions pass over an empty scan.`,
    );
  }
  return readFileSync(path, "utf8").split("\r\n").join("\n");
}

const WORKFLOW = readWorkflow(WORKFLOW_PATH);

/**
 * Everything after the top-level `jobs:` key. Scoping matters: the `on:` block
 * above it holds `  push:` and `  pull_request:` at the SAME two-space
 * indentation as a job id, and neither is a job.
 */
function jobsRegion(workflow: string): string {
  const match = /^jobs:[ \t]*$/m.exec(workflow);
  if (!match) {
    throw new Error("No top-level `jobs:` key found in the CI workflow.");
  }
  return workflow.slice(match.index + match[0].length);
}

/** Two-space-indented bare keys inside the jobs region, in file order. */
function jobIds(workflow: string): string[] {
  const matches = jobsRegion(workflow).matchAll(
    /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm,
  );
  return [...matches].map((match) => match[1]);
}

/** Every job that the gate must wait on: not the gate, not a CD job. */
function ciJobIds(ids: string[]): string[] {
  return ids.filter(
    (id) =>
      id !== GATE_JOB_ID &&
      !CD_JOB_PREFIXES.some((prefix) => id.startsWith(prefix)),
  );
}

/** The lines of one job, from its key up to the next job key (or EOF). */
function jobBlock(workflow: string, jobId: string): string {
  const region = jobsRegion(workflow);
  const start = new RegExp(`^ {2}${jobId}:[ \\t]*$`, "m").exec(region);
  if (!start) {
    throw new Error(`Job \`${jobId}\` not found in the CI workflow.`);
  }
  const rest = region.slice(start.index + start[0].length);
  const next = /^ {2}[A-Za-z0-9_-]+:[ \t]*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The job ids of an inline `needs: [a, b, c]` list. */
function needsList(block: string): string[] {
  const match = /^\s*needs:\s*\[([^\]]*)\]/m.exec(block);
  if (!match) {
    throw new Error(
      `\`${GATE_JOB_ID}\` has no inline \`needs: [...]\` list — the gate's ` +
        `dependencies can no longer be read, so this guard proves nothing.`,
    );
  }
  return match[1]
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** The job ids referenced as `needs.<job>.result` inside `results="..."`. */
function resultRefs(block: string): string[] {
  const match = /^\s*results="([^"]*)"/m.exec(block);
  if (!match) {
    throw new Error(
      `\`${GATE_JOB_ID}\` has no \`results="..."\` line — the step that ` +
        `inspects the job results can no longer be read.`,
    );
  }
  const refs = match[1].matchAll(/needs\.([A-Za-z0-9_-]+)\.result/g);
  return [...refs].map((ref) => ref[1]);
}

const JOB_IDS = jobIds(WORKFLOW);
const CI_JOB_IDS = ciJobIds(JOB_IDS);
const GATE_BLOCK = jobBlock(WORKFLOW, GATE_JOB_ID);
const GATE_NEEDS = needsList(GATE_BLOCK);
const GATE_RESULT_REFS = resultRefs(GATE_BLOCK);

/**
 * The jobs the scan MUST see. Positive companion to the "every CI job is in
 * the gate" assertions: without it, a regex that matched nothing would make
 * them pass over an empty list. Deliberately containment, not equality — a new
 * job is caught by the gate assertions, which is where the decision belongs.
 */
const EXPECTED_CI_JOB_IDS = [
  "changes",
  "extension-check",
  "worker-check",
  "pwa-check",
  "e2e",
  "pwa-e2e",
];
const EXPECTED_CD_JOB_IDS = ["deploy-worker-dev", "release-extension"];

describe("ci-success gate in .github/workflows/cicd.yml", () => {
  it("reads the workflow from a path that exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
    expect(WORKFLOW).toContain("name: CI Success");
  });

  it("finds the pipeline's job ids and no trigger keys from the on: block", () => {
    for (const id of [...EXPECTED_CI_JOB_IDS, ...EXPECTED_CD_JOB_IDS]) {
      expect(JOB_IDS).toContain(id);
    }
    // `  push:` / `  pull_request:` live in the `on:` block at the same
    // indentation as a job key; picking them up would mean the scan is not
    // scoped to the jobs region and the CI/CD partition is meaningless.
    expect(JOB_IDS).not.toContain("push");
    expect(JOB_IDS).not.toContain("pull_request");
  });

  it("classifies deploy-/release- jobs as CD and excludes the gate itself", () => {
    for (const id of EXPECTED_CI_JOB_IDS) {
      expect(CI_JOB_IDS).toContain(id);
    }
    for (const id of [...EXPECTED_CD_JOB_IDS, GATE_JOB_ID]) {
      expect(CI_JOB_IDS).not.toContain(id);
    }
  });

  it.each(CI_JOB_IDS)("waits on the CI job %s via needs", (jobId) => {
    // Missing here, the job runs in parallel with the gate (or not at all) and
    // its outcome never reaches the required status check.
    expect(GATE_NEEDS).toContain(jobId);
  });

  it.each(CI_JOB_IDS)("inspects the CI job %s's result", (jobId) => {
    // In `needs` but absent from `results` is the subtler half of the same
    // bug: the gate waits for the job and then ignores how it ended.
    expect(GATE_RESULT_REFS).toContain(jobId);
  });

  it("runs the gate unconditionally via always()", () => {
    // The second pillar of the design: `needs` decides which jobs the gate
    // waits for, `always()` decides that it reports at all. Weakened to
    // `success()` — or to the look-alike `!cancelled()` the check jobs use —
    // the gate skips itself in exactly the runs it exists to report on, and
    // its own `cancelled` branch becomes unreachable. The four-space indent
    // pins the JOB-level `if:`; a step's `if:` sits at eight, so a step-level
    // always() elsewhere in the block cannot satisfy this.
    expect(GATE_BLOCK).toMatch(/^ {4}if:\s*\$\{\{\s*always\(\)\s*\}\}[ \t]*$/m);
  });
});
