// Anchor-checked, regex-only readers for `.github/workflows/cicd.yml` (no YAML library);
// each one's contract and loud-throw behaviour is in its JSDoc.
import { existsSync, readFileSync } from "node:fs";

/** Reads the workflow as UTF-8, CRLF-normalised; throws loudly when absent. */
export function readWorkflow(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `CI workflow not found at ${path}. This guard is only meaningful while ` +
        `it reads the real file — update the path instead of letting the ` +
        `assertions pass over an empty scan.`,
    );
  }
  return readFileSync(path, "utf8").split("\r\n").join("\n");
}

/**
 * Everything after the top-level `jobs:` key; throws when that key is absent.
 *
 * Scoping matters: the `on:` block above it holds `  push:` and
 * `  pull_request:` at the SAME two-space indentation as a job id, and neither
 * is a job — picking them up would mean the scan is not scoped to the jobs
 * region and the CI/CD partition is meaningless.
 */
export function jobsRegion(workflow: string): string {
  const match = /^jobs:[ \t]*$/m.exec(workflow);
  if (!match) {
    throw new Error("No top-level `jobs:` key found in the CI workflow.");
  }
  return workflow.slice(match.index + match[0].length);
}

/** The lines of one job, from its key up to the next job key (or EOF). */
export function jobBlock(workflow: string, jobId: string): string {
  const region = jobsRegion(workflow);
  const start = new RegExp(`^ {2}${jobId}:[ \\t]*$`, "m").exec(region);
  if (!start) {
    throw new Error(`Job \`${jobId}\` not found in the CI workflow.`);
  }
  const rest = region.slice(start.index + start[0].length);
  const next = /^ {2}[A-Za-z0-9_-]+:[ \t]*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * The body of `<key>:` indented by `indent` spaces, up to the first non-blank
 * line indented no further than the key itself.
 *
 * A trailing block-scalar indicator (`|` as in `filters: |`, `>-` as in a
 * job's multi-line `if: >-`, with an optional `-` / `+` chomping mark) is
 * tolerated so the same helper reads those too. It returns `null` when the key
 * is absent — callers decide how loudly that matters, since "the block does
 * not exist" IS the finding for some of them.
 */
export function keyBlock(
  source: string,
  indent: number,
  key: string,
): string | null {
  const pad = " ".repeat(indent);
  const start = new RegExp(
    `^${pad}${key}:[ \\t]*(?:[|>][-+]?)?[ \\t]*$`,
    "m",
  ).exec(source);
  if (!start) {
    return null;
  }
  const body: string[] = [];
  for (const line of source.slice(start.index + start[0].length).split("\n")) {
    if (line.trim().length === 0) {
      body.push(line);
      continue;
    }
    if (!line.startsWith(`${pad} `)) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}

/** Every step slice of one job block, in file order; throws when the job has none. */
export function jobSteps(block: string, jobId: string): string[] {
  const starts = [...block.matchAll(/^ {6}- .*$/gm)];
  if (starts.length === 0) {
    throw new Error(`Job \`${jobId}\` has no 6-space \`- \` steps to scan.`);
  }
  return starts.map((start) => {
    const rest = block.slice((start.index ?? 0) + start[0].length);
    const next = /^ {6}- /m.exec(rest);
    return start[0] + (next ? rest.slice(0, next.index) : rest);
  });
}

/** Index of the ONE step named `name`; throws when it is absent or duplicated. */
export function stepIndexNamed(steps: string[], name: string): number {
  const header = `      - name: ${name}`;
  const hits = steps
    .map((step, index) =>
      step.split("\n")[0].trimEnd() === header ? index : -1,
    )
    .filter((index) => index >= 0);
  if (hits.length !== 1) {
    throw new Error(
      `Expected exactly one step named \`${name}\`, found ${hits.length} — ` +
        `the step this guard reads was renamed or duplicated.`,
    );
  }
  return hits[0];
}

/** The ONE step named `stepName` in job `jobId`; throws via `stepIndexNamed` when absent. */
export function namedStep(
  workflow: string,
  jobId: string,
  stepName: string,
): string {
  const steps = jobSteps(jobBlock(workflow, jobId), jobId);
  return steps[stepIndexNamed(steps, stepName)];
}

/** A step's `run:` script — inline value or `|` / `>-` block body; throws when absent or empty. */
export function stepRun(step: string, stepName: string): string {
  const line = /^ {8}run:[ \t]*(.*)$/m.exec(step);
  if (!line) {
    throw new Error(`Step \`${stepName}\` has no 8-space \`run:\` key.`);
  }
  const inline = line[1].trim();
  const script =
    inline.length > 0 && !/^[|>][-+]?$/.test(inline)
      ? inline
      : keyBlock(step, 8, "run");
  if (script === null || script.trim().length === 0) {
    throw new Error(`Step \`${stepName}\` has an empty \`run:\` script.`);
  }
  return script;
}
