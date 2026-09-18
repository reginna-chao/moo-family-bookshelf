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
 * WHAT ELSE THIS FILE PINS. Three properties beyond the gate's `needs` list,
 * each closing another route to a quietly green — or quietly over-permissioned
 * — pipeline:
 *
 *   1. The gate's ENFORCEMENT half. `needs` and `results` only decide what the
 *      gate's step SEES; the shell loop is what turns a `failure` into a
 *      non-zero exit. Change `exit 1` to `exit 0`, drop either comparison, or
 *      hang a `continue-on-error: true` on the job, and every assertion about
 *      `needs` / `results` stays true while the required check reports success
 *      over a failed pipeline.
 *
 *   2. `changes` NAME CONSISTENCY. An output key, a `filters:` name and a
 *      `needs.changes.outputs.<name>` reference are three independent
 *      spellings of one name, and GitHub Actions validates none of them: a
 *      mismatch evaluates to the empty string, `== 'true'` is false, and the
 *      job SKIPS. No error is raised anywhere, and the gate tolerates
 *      `skipped` by design (that is what path filtering looks like), so the
 *      typo is invisible end to end. Every filter must additionally list the
 *      workflow file itself — without it, a change to `cicd.yml` does not
 *      trigger the very jobs it rewrites.
 *
 *   3. TOKEN PERMISSIONS. Without a top-level `permissions:` block the
 *      `GITHUB_TOKEN` inherits the repository default, which can be
 *      read-write for every job in the file; and `actions/checkout` persists
 *      that token into `.git/config` by default, leaving it readable by every
 *      later step in the job, third-party actions included. Both are silent —
 *      nothing in a green run says the token was broader than needed. The
 *      credential rule is workflow-wide, not CI-only: EVERY
 *      `actions/checkout` step in the file must opt out, CD jobs and second
 *      checkouts of the same job included, because a leaked credential does
 *      not care which job's `.git/config` it was left in.
 *
 * HOW IT AVOIDS PASSING VACUOUSLY. The scan is parsed out of the file by
 * regex, so a drifted pattern (or a moved file) could match nothing and make
 * every "is in the gate" assertion trivially true over an empty job list.
 * Three things stop that: the path is resolved relative to THIS file (absent
 * the mutation-check seam below) and its existence is asserted, every helper
 * throws when its anchor is missing instead of returning an empty result, and
 * the positive companions pin what the scan must find — the six CI jobs plus
 * two CD jobs, the change-filter names, a checkout step in each CI job, and
 * the `continue-on-error` token whose absence from the gate block is asserted
 * elsewhere in the file.
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
 * MUTATION-CHECK SEAM (same device as `kvAccessBoundary.test.ts`'s scan roots
 * and `nodeEngineFloor.test.ts`'s package.json paths). The path is overridable
 * purely so these guards can be driven RED against a throwaway COPY of the
 * workflow at authoring time, WITHOUT editing the live `.github/workflows/`
 * file. CI sets no such variable. A seam value pointing at NOTHING throws
 * loudly in `readWorkflow` below; a seam value pointing at a VALID copy is the
 * intended mutation-check use, and the guards then read that copy rather than
 * the repo's workflow, undetected.
 *
 * Resolved from THIS file, not `process.cwd()`: vitest runs with the `worker/`
 * package as its cwd, and the workflow sits two levels above it.
 */
const WORKFLOW_PATH =
  process.env.MOO_CI_WORKFLOW_PATH ??
  resolve(HERE, "../../../.github/workflows/cicd.yml");

/** The aggregate gate itself — required status check, never its own dependency. */
const GATE_JOB_ID = "ci-success";

/** The path-filter job whose outputs every check job's `if:` reads. */
const CHANGES_JOB_ID = "changes";

/** Job-id prefixes that are CD, and correctly sit outside the CI gate. */
const CD_JOB_PREFIXES = ["deploy-", "release-"];

/**
 * The workflow's own path, as a path-filter glob. Every filter lists it so a
 * workflow edit runs the whole pipeline — including the jobs that edit changed.
 */
const WORKFLOW_SELF_GLOB = ".github/workflows/cicd.yml";

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

/**
 * Everything BEFORE the top-level `jobs:` key — `name:`, `on:` and the
 * top-level `permissions:` block live here. The complement of `jobsRegion`,
 * so it inherits that helper's loud throw when the anchor is gone.
 */
function preJobsRegion(workflow: string): string {
  return workflow.slice(0, workflow.length - jobsRegion(workflow).length);
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

/**
 * The body of `<key>:` indented by `indent` spaces, up to the first non-blank
 * line indented no further than the key itself. A trailing `|` (block scalar,
 * as in `filters: |`) is tolerated so the same helper reads those too.
 * Returns `null` when the key is absent — callers decide how loudly that
 * matters, since "the block does not exist" IS the finding for some of them.
 */
function keyBlock(source: string, indent: number, key: string): string | null {
  const pad = " ".repeat(indent);
  const start = new RegExp(`^${pad}${key}:[ \\t]*\\|?[ \\t]*$`, "m").exec(
    source,
  );
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

// ===========================================================================
// The `changes` job: outputs, path filters, and how they are referenced
// ===========================================================================

/** The output names the `changes` job publishes, in file order. */
function outputKeys(changesBlock: string): string[] {
  const block = keyBlock(changesBlock, 4, "outputs");
  if (block === null) {
    throw new Error(
      `\`${CHANGES_JOB_ID}\` has no \`outputs:\` block — the names every ` +
        `check job's \`if:\` reads can no longer be enumerated.`,
    );
  }
  const keys = [...block.matchAll(/^ {6}([A-Za-z0-9_-]+):/gm)].map(
    (match) => match[1],
  );
  if (keys.length === 0) {
    throw new Error(
      `\`${CHANGES_JOB_ID}.outputs\` parsed to zero names — the scan drifted ` +
        `and every comparison against it would be vacuous.`,
    );
  }
  return keys;
}

/**
 * The `dorny/paths-filter` `filters:` block as `name -> globs`. Deliberately
 * STRICT: an unrecognised line throws rather than being skipped, because a
 * silently dropped glob would make the "every filter lists the workflow file"
 * assertion below pass over an incomplete list.
 */
function pathFilters(changesBlock: string): Map<string, string[]> {
  const block = keyBlock(changesBlock, 10, "filters");
  if (block === null) {
    throw new Error(
      `No \`filters: |\` block found in the \`${CHANGES_JOB_ID}\` job — the ` +
        `path filters can no longer be read.`,
    );
  }
  const filters = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const name = /^ {12}([A-Za-z0-9_-]+):[ \t]*$/.exec(line);
    if (name) {
      current = [];
      filters.set(name[1], current);
      continue;
    }
    const glob = /^ {14}- '([^']*)'[ \t]*$/.exec(line);
    if (glob) {
      if (current === null) {
        throw new Error(
          `Glob '${glob[1]}' appears before any filter name in the ` +
            `\`${CHANGES_JOB_ID}\` filters block.`,
        );
      }
      current.push(glob[1]);
      continue;
    }
    throw new Error(
      `Unparsable line in the \`${CHANGES_JOB_ID}\` filters block: ` +
        `${JSON.stringify(line)}. The parser expects a 12-space \`name:\` or ` +
        `a 14-space \`- 'glob'\`; fix the parser rather than letting globs go ` +
        `unchecked.`,
    );
  }
  if (filters.size === 0) {
    throw new Error(
      `The \`${CHANGES_JOB_ID}\` filters block parsed to zero filters — the ` +
        `scan drifted and every per-filter assertion would be vacuous.`,
    );
  }
  return filters;
}

/** Every name referenced anywhere as `needs.changes.outputs.<name>`. */
function outputRefNames(workflow: string): string[] {
  const refs = workflow.matchAll(
    new RegExp(`needs\\.${CHANGES_JOB_ID}\\.outputs\\.([A-Za-z0-9_-]+)`, "g"),
  );
  return [...refs].map((ref) => ref[1]);
}

/** Sorted, de-duplicated — these are SETS of names, order is not the point. */
function nameSet(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/** A failure message naming exactly which names are missing / unexpected. */
function nameSetDiff(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): string {
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  return (
    `${label} — missing: [${missing.join(", ")}], ` +
    `unexpected: [${unexpected.join(", ")}]. All three spellings of a change ` +
    `filter name (output key, filter name, needs.${CHANGES_JOB_ID}.outputs ` +
    `reference) must match, or the job silently skips.`
  );
}

// ===========================================================================
// Steps: every actions/checkout in the file
// ===========================================================================

/**
 * EVERY `actions/checkout` step slice in `source`, in file order — each from
 * its `- uses:` line to the next step at the same indentation. Deliberately
 * ALL of them, not the first: a job may check out twice, and the second
 * checkout is exactly where an opt-out gets forgotten. Pass a job block to
 * scope it to one job, or the whole workflow to count them.
 */
function checkoutSteps(source: string): string[] {
  const starts = [...source.matchAll(/^ {6}- uses: actions\/checkout@.*$/gm)];
  return starts.map((start) => {
    const rest = source.slice((start.index ?? 0) + start[0].length);
    const next = /^ {6}- /m.exec(rest);
    return start[0] + (next ? rest.slice(0, next.index) : rest);
  });
}

// ===========================================================================
// Derived values
// ===========================================================================

const JOB_IDS = jobIds(WORKFLOW);
const CI_JOB_IDS = ciJobIds(JOB_IDS);
const GATE_BLOCK = jobBlock(WORKFLOW, GATE_JOB_ID);
const GATE_NEEDS = needsList(GATE_BLOCK);
const GATE_RESULT_REFS = resultRefs(GATE_BLOCK);

const CHECKOUT_STEPS = checkoutSteps(WORKFLOW);
/**
 * Every line that USES actions/checkout, in EITHER step spelling — the
 * `- uses:` form `checkoutSteps` slices, and the `- name:` + next-line `uses:`
 * form it cannot see. Comment lines never match (the `#` precedes `uses:`).
 */
const CHECKOUT_USES_LINES = [
  ...WORKFLOW.matchAll(/^[ \t]*(?:- )?uses: actions\/checkout@/gm),
];
/** Every job that checks out at all — CI and CD alike; the rule covers both. */
const JOB_IDS_WITH_CHECKOUT = JOB_IDS.filter(
  (id) => checkoutSteps(jobBlock(WORKFLOW, id)).length > 0,
);

const CHANGES_BLOCK = jobBlock(WORKFLOW, CHANGES_JOB_ID);
const PATH_FILTERS = pathFilters(CHANGES_BLOCK);
const FILTER_NAMES = nameSet([...PATH_FILTERS.keys()]);
const OUTPUT_KEYS = nameSet(outputKeys(CHANGES_BLOCK));
const OUTPUT_REF_NAMES = nameSet(outputRefNames(WORKFLOW));

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

/**
 * Positive companion to the three-way set equality: three EMPTY sets compare
 * equal to one another, so at least these names must be present. Containment,
 * not equality — adding a package is a legitimate change, and the set equality
 * is what then forces it to be spelled consistently in all three places.
 */
const EXPECTED_FILTER_NAMES = ["extension", "pwa", "worker"];

/**
 * How many `actions/checkout` steps the scan must find: one in each of the six
 * CI jobs, plus one in each of the seven CD jobs (deploy-worker-dev,
 * deploy-pwa-dev, deploy-pages, deploy-worker-prod, deploy-pwa-prod,
 * release-extension, release-extension-firefox). Positive companion to the
 * workflow-wide rule below — a drifted step regex matching nothing would
 * otherwise satisfy "every checkout opts out" over an empty list. A floor,
 * not an equality: adding a job is legitimate, and the rule then covers it.
 */
const EXPECTED_CHECKOUT_COUNT = 13;

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

describe("ci-success gate enforcement step", () => {
  it("fails the run on a failure or cancelled result", () => {
    // Reading the results is not enforcing them. Both comparisons and the
    // non-zero exit are the whole of the enforcement: drop either branch and
    // that outcome passes silently; turn `exit 1` into `exit 0` and EVERY
    // outcome does, with `needs` and `results` still perfectly correct above.
    expect(GATE_BLOCK).toMatch(/\[\s*"\$r"\s*=\s*"failure"\s*\]/);
    expect(GATE_BLOCK).toMatch(/\[\s*"\$r"\s*=\s*"cancelled"\s*\]/);
    expect(GATE_BLOCK).toMatch(/^\s*exit 1[ \t]*$/m);
  });

  it("never marks the gate or its step continue-on-error", () => {
    // `continue-on-error` reports the job as SUCCESS whatever the step's exit
    // code, so the assertion above would keep passing over a gate that can no
    // longer fail anything. Nothing in the gate's block may carry it —
    // job-level or step-level.
    expect(GATE_BLOCK).not.toContain("continue-on-error");
  });

  it("still finds continue-on-error elsewhere in the workflow", () => {
    // Positive companion to the negative above: the AMO-listed submission step
    // of release-extension-firefox is deliberately non-blocking. If that token
    // ever disappears from the file entirely, the negative assertion would be
    // proving nothing and this case says so out loud.
    expect(WORKFLOW).toContain("continue-on-error");
  });
});

describe("changes job path filters", () => {
  it.each(FILTER_NAMES)(
    "makes a change to the workflow itself trigger the %s filter",
    (filterName) => {
      // A workflow edit that does not match a filter leaves that package's
      // checks unrun on the very PR that rewrote them — and the gate reads the
      // resulting `skipped` as a pass. Every filter therefore lists the
      // workflow file, so any change to cicd.yml runs the whole pipeline.
      const globs = PATH_FILTERS.get(filterName);
      expect(globs).toBeDefined();
      expect(globs).toContain(WORKFLOW_SELF_GLOB);
    },
  );
});

describe("changes job name consistency", () => {
  it("finds the expected change-filter names", () => {
    // Positive companion to the set equality below, which three empty sets
    // would satisfy. Also guards the it.each above from running zero cases.
    for (const name of EXPECTED_FILTER_NAMES) {
      expect(FILTER_NAMES).toContain(name);
      expect(OUTPUT_KEYS).toContain(name);
      expect(OUTPUT_REF_NAMES).toContain(name);
    }
  });

  it("spells every filter name identically in outputs, filters and references", () => {
    // Three independent spellings, validated by nothing in Actions: a mismatch
    // yields the empty string, `== 'true'` is false, and the job SKIPS with no
    // error — which the gate accepts as path filtering.
    expect(
      OUTPUT_KEYS,
      nameSetDiff(
        "`changes.outputs` keys vs `filters:` names",
        OUTPUT_KEYS,
        FILTER_NAMES,
      ),
    ).toEqual(FILTER_NAMES);
    expect(
      OUTPUT_REF_NAMES,
      nameSetDiff(
        `\`needs.${CHANGES_JOB_ID}.outputs.*\` references vs \`changes.outputs\` keys`,
        OUTPUT_REF_NAMES,
        OUTPUT_KEYS,
      ),
    ).toEqual(OUTPUT_KEYS);
  });
});

describe("workflow token permissions", () => {
  it("declares a read-only default at the top level, above jobs:", () => {
    // Absent this block the GITHUB_TOKEN of every job inherits the repository
    // default, which can be read-write — a compromised dependency in any job
    // could then push. It must sit in the region ABOVE `jobs:`: the same key
    // inside a job grants that one job only and leaves the default untouched.
    const block = keyBlock(preJobsRegion(WORKFLOW), 0, "permissions");
    expect(
      block,
      "No top-level `permissions:` block above `jobs:` — every job would " +
        "inherit the repository's default GITHUB_TOKEN scope.",
    ).not.toBeNull();
    expect(block).toMatch(/^ {2}contents:[ \t]*read[ \t]*$/m);
  });

  it("grants the changes job the pull-requests read it needs", () => {
    // Once the top-level block zeroes everything else, `dorny/paths-filter`
    // still needs `pull-requests: read` on pull_request events to list the
    // changed files. Without it the action fails, outputs are empty, and every
    // check job skips — the exact vacuous-green shape this file exists to stop.
    const block = keyBlock(CHANGES_BLOCK, 4, "permissions");
    expect(
      block,
      "No `permissions:` block in the `changes` job — dorny/paths-filter " +
        "cannot read the pull request's changed files under a read-only " +
        "top-level default.",
    ).not.toBeNull();
    expect(block).toMatch(/^ {6}pull-requests:[ \t]*read[ \t]*$/m);
    // A job-level block REPLACES the top-level one rather than extending it,
    // so `contents: read` has to be restated here — without it this job has
    // no read access to the repository at all and the checkout above fails.
    expect(block).toMatch(/^ {6}contents:[ \t]*read[ \t]*$/m);
  });

  it("finds a checkout step in every CI job and across the whole workflow", () => {
    // Cross-check FIRST, so a step the slicer cannot see reports as itself
    // rather than as a count that fell under the floor below.
    expect(
      CHECKOUT_STEPS.length,
      "A checkout written as `- name:` + a next-line `uses:` is invisible to " +
        "checkoutSteps, so its job drops out of JOB_IDS_WITH_CHECKOUT and the " +
        "persist-credentials rule silently skips it. Teach checkoutSteps that " +
        "spelling rather than leaving the step unchecked.",
    ).toBe(CHECKOUT_USES_LINES.length);
    // Positive companion to the workflow-wide rule below: a step regex that
    // matched nothing would make "every checkout opts out" vacuously true.
    // (Both counts being zero satisfies the equality above — this is what
    // catches that.)
    expect(CHECKOUT_STEPS.length).toBeGreaterThanOrEqual(
      EXPECTED_CHECKOUT_COUNT,
    );
    for (const jobId of CI_JOB_IDS) {
      expect(checkoutSteps(jobBlock(WORKFLOW, jobId)).length).toBeGreaterThan(
        0,
      );
    }
  });

  // Driven off the jobs that actually check out, not a hard-coded list: a new
  // job — CI or CD — inherits the rule automatically, and the case above is
  // what stops that list from silently shrinking to nothing.
  it.each(JOB_IDS_WITH_CHECKOUT)(
    "checks out %s without persisting credentials",
    (jobId) => {
      // actions/checkout stores the token in .git/config by default, where
      // every later step of the job — including third-party actions and
      // anything `pnpm install` runs — can read it. No job in this workflow
      // runs a git network command after checkout, and the two `gh` calls
      // (release create / release upload) take GH_TOKEN from their own step
      // env, so nothing here needs the credential to outlive the checkout.
      // EVERY checkout of the job is checked, not just the first: a second
      // checkout without the opt-out re-persists the token.
      const steps = checkoutSteps(jobBlock(WORKFLOW, jobId));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step).toMatch(/^\s+persist-credentials:[ \t]*false[ \t]*$/m);
      }
    },
  );
});
