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
 * WHAT ELSE THIS FILE PINS. Six properties beyond the gate's `needs` list,
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
 *      not care which job's `.git/config` it was left in. The mirror image is
 *      pinned too: a job-level `permissions:` block REPLACES the top-level
 *      one rather than extending it, so any job that declares its own must
 *      restate `contents:` or its checkout runs with no repository read at
 *      all — which only passes today because this repository is public.
 *
 *   4. SPECIFIC FILTER GLOBS. Property 2 proves a filter is spelled
 *      consistently; it says nothing about WHICH files trigger it. A glob
 *      dropped from a filter skips that package's checks on exactly the PR
 *      that needed them, and the gate reads the `skipped` as a pass. The
 *      globs pinned here each guard a change class no package directory
 *      covers — the workspace definition, the root `.env.*` files, the Docker
 *      files — plus the one non-filter wiring that rides on them:
 *      `worker-check`'s job-level `if:` accepting the `docker` output.
 *
 *   5. AMO-LISTED FAILURE VISIBILITY. The listed submission is deliberately
 *      non-blocking (`continue-on-error: true`), which on its own turns a
 *      failed submission into a green run with nothing to say it happened.
 *      A follow-up step keyed on that step's `outcome` prints a `::warning::`
 *      and the log tail. The wiring is four independent spellings — the
 *      step `id`, the follow-up's `steps.<id>.outcome`, the `tee` log path,
 *      the `tail` log path — and an explicit `shell: bash`, all pinned.
 *
 *   6. NPX-FREE CLI CALLS. Every CLI the workflow runs — release steps holding
 *      the AMO and Cloudflare secrets included — resolves to the
 *      lockfile-pinned bin, never to whatever the registry serves that day:
 *      no downloading runner (`npx` / `pnpx` / `pnx` / `bunx`, `npm exec` /
 *      `npm x`, `pnpm … dlx` / `yarn … dlx`) on any non-comment line, the
 *      Firefox web-ext steps run from `extension/`, and the two Pages deploys
 *      run the worker's own wrangler from the repo root.
 *
 * HOW IT AVOIDS PASSING VACUOUSLY. The scan is parsed out of the file by
 * regex, so a drifted pattern (or a moved file) could match nothing and make
 * every "is in the gate" assertion trivially true over an empty job list.
 * Three things stop that: the path is resolved relative to THIS file (absent
 * the mutation-check seam below) and its existence is asserted, every helper
 * throws when its anchor is missing instead of returning an empty result, and
 * the positive companions pin what the scan must find — the nine CI jobs plus
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
 *
 * MUTATION-CHECK SEAM (`WORKFLOW_PATH`; same device as
 * `kvAccessBoundary.test.ts`'s scan roots and `nodeEngineFloor.test.ts`'s
 * package.json paths). The path is overridable through `MOO_CI_WORKFLOW_PATH`
 * purely so these guards can be driven RED against a throwaway COPY of the
 * workflow at authoring time, WITHOUT editing the live `.github/workflows/`
 * file. CI sets no such variable. A seam value pointing at NOTHING throws
 * loudly in `readWorkflow`; a seam value pointing at a VALID copy is the
 * intended mutation-check use, and the guards then read that copy rather than
 * the repo's workflow, undetected. Resolved from THIS file, not
 * `process.cwd()`: vitest runs with the `worker/` package as its cwd, and the
 * workflow sits two levels above it.
 *
 * THE SCAN HELPERS.
 *  - `jobsRegion` is everything after the top-level `jobs:` key. Scoping
 *    matters: the `on:` block above it holds `  push:` and `  pull_request:` at
 *    the SAME two-space indentation as a job id, and neither is a job — picking
 *    them up would mean the scan is not scoped to the jobs region and the CI/CD
 *    partition is meaningless. `preJobsRegion` is everything BEFORE it —
 *    `name:`, `on:` and the top-level `permissions:` block live there; as the
 *    complement of `jobsRegion` it inherits that helper's loud throw when the
 *    anchor is gone.
 *  - `keyBlock` returns the body of `<key>:` indented by `indent` spaces, up to
 *    the first non-blank line indented no further than the key itself. A
 *    trailing block-scalar indicator (`|` as in `filters: |`, `>-` as in a
 *    job's multi-line `if: >-`, with an optional `-` / `+` chomping mark) is
 *    tolerated so the same helper reads those too. It returns `null` when the key is absent — callers
 *    decide how loudly that matters, since "the block does not exist" IS the
 *    finding for some of them.
 *  - `outputBindings` parses the `changes` job's `outputs:` block WHOLE — key,
 *    source step and source output. Reading only the key left of the colon is
 *    not enough: the value is a second, independent spelling of the same name,
 *    and a typo there (`steps.filter.outputs.extensoin`) resolves to the empty
 *    string, skips the job, and shows up nowhere. `pathFilters` reads the
 *    `dorny/paths-filter` `filters:` block as `name -> globs`. Both are
 *    deliberately STRICT: an unrecognised line throws rather than being
 *    skipped, because a silently dropped glob would make the "every filter
 *    lists the workflow file" assertion pass over an incomplete list.
 *  - `checkoutSteps` returns EVERY `actions/checkout` step slice in `source`,
 *    in file order — each from its `- uses:` line to the next step at the same
 *    indentation. Deliberately ALL of them, not the first: a job may check out
 *    twice, and the second checkout is exactly where an opt-out gets
 *    forgotten. Pass a job block to scope it to one job, or the whole workflow
 *    to count them. `CHECKOUT_USES_LINES` is every line that USES
 *    actions/checkout, in EITHER step spelling — the `- uses:` form
 *    `checkoutSteps` slices, and the `- name:` + next-line `uses:` form it
 *    cannot see. Comment lines never match (the `#` precedes `uses:`).
 *  - `JOBS_WITH_OWN_PERMISSIONS` are the checkout jobs that declare their OWN
 *    `permissions:` block, and so no longer inherit the top-level
 *    `contents: read`. A job without a block is exempt by construction: it gets
 *    the top-level scope unchanged.
 *
 * THE POSITIVE COMPANIONS (each a floor or a containment check, never an
 * equality, so a legitimate addition stays green and is covered by the rule):
 *  - `EXPECTED_CI_JOB_IDS` — the jobs the scan MUST see. Without it, a regex
 *    that matched nothing would make the "every CI job is in the gate"
 *    assertions pass over an empty list. A new job is caught by the gate
 *    assertions, which is where the decision belongs.
 *  - `EXPECTED_FILTER_NAMES` — three EMPTY sets compare equal to one another,
 *    so at least these names must be present; adding a package is legitimate,
 *    and the three-way set equality is what then forces it to be spelled
 *    consistently in all three places.
 *  - `EXPECTED_CHECKOUT_COUNT` (16) — how many `actions/checkout` steps the
 *    scan must find: one in each of the nine CI jobs (changes,
 *    extension-check, worker-check, pwa-check, e2e, pwa-e2e, format, audit,
 *    docker), plus one in each of the seven CD jobs (deploy-worker-dev, deploy-pwa-dev, deploy-pages,
 *    deploy-worker-prod, deploy-pwa-prod, release-extension,
 *    release-extension-firefox). A drifted step regex matching nothing would
 *    otherwise satisfy "every checkout opts out" over an empty list (both
 *    counts being zero satisfies the step-vs-line equality — the floor is what
 *    catches that). The per-job credential cases are driven off the jobs that
 *    actually check out, not a hard-coded list: a new job — CI or CD — inherits
 *    the rule automatically, and the floor is what stops that list from
 *    silently shrinking to nothing.
 *  - `EXPECTED_JOBS_WITH_OWN_PERMISSIONS` — the checkout jobs that override the
 *    token scope today. A `keyBlock` that stopped matching a job-level
 *    `permissions:` would empty the list and the "restate contents:" rule would
 *    run zero cases while staying green.
 *
 * GATE ENFORCEMENT, in detail (property 1).
 *  - `always()` is the second pillar of the design: `needs` decides which jobs
 *    the gate waits for, `always()` decides that it reports at all. Weakened to
 *    `success()` — or to the look-alike `!cancelled()` the check jobs use — the
 *    gate skips itself in exactly the runs it exists to report on, and its own
 *    `cancelled` branch becomes unreachable. The four-space indent pins the
 *    JOB-level `if:`; a step's `if:` sits at eight, so a step-level always()
 *    elsewhere in the block cannot satisfy it.
 *  - Reading the results is not enforcing them. The COMBINED condition is
 *    pinned as one whole line, not as two fragments that happen to be present:
 *    `||` silently rewritten to `&&` leaves both comparisons in the file and
 *    satisfies any fragment match, while no result is ever both `failure` and
 *    `cancelled`, so the gate can never exit non-zero. Dropping either branch,
 *    or turning `exit 1` into `exit 0`, has the same effect with `needs` and
 *    `results` still perfectly correct. Whitespace is tolerated only where the
 *    shell allows it — inside the test brackets, around the `=`, around the
 *    `||`, and around the `;`.
 *  - `continue-on-error` reports the job as SUCCESS whatever the step's exit
 *    code, so the condition assertion would keep passing over a gate that can
 *    no longer fail anything. Nothing in the gate's block may carry it —
 *    job-level or step-level. Its positive companion: the AMO-listed submission
 *    step of release-extension-firefox is deliberately non-blocking, so the
 *    token exists in the file; if it ever disappears entirely, the negative
 *    assertion would be proving nothing and the companion says so out loud.
 *
 * NAME CONSISTENCY, in detail (property 2).
 *  - A workflow edit that does not match a filter leaves that package's checks
 *    unrun on the very PR that rewrote them — and the gate reads the resulting
 *    `skipped` as a pass. Every filter therefore lists the workflow file
 *    (`WORKFLOW_SELF_GLOB`), so any change to cicd.yml runs the whole pipeline,
 *    including the jobs the edit changed.
 *  - Output keys, filter names and `needs.changes.outputs.<name>` references
 *    are three independent spellings, validated by nothing in Actions: a
 *    mismatch yields the empty string, `== 'true'` is false, and the job SKIPS
 *    with no error — which the gate accepts as path filtering.
 *  - The set equality compares only the names LEFT of the colon. The value is a
 *    fourth spelling: `${{ steps.filter.outputs.extension }}`. A typo on that
 *    side (`…outputs.extensoin`, or a step id that no step carries) resolves to
 *    the empty string, so the output is published as "" and every job gated on
 *    it skips — with nothing red anywhere.
 *
 * TOKEN PERMISSIONS, in detail (property 3).
 *  - Absent the top-level block the GITHUB_TOKEN of every job inherits the
 *    repository default, which can be read-write — a compromised dependency in
 *    any job could then push. It must sit in the region ABOVE `jobs:`: the same
 *    key inside a job grants that one job only and leaves the default
 *    untouched.
 *  - Once the top-level block zeroes everything else, `dorny/paths-filter`
 *    still needs `pull-requests: read` on pull_request events to list the
 *    changed files. Without it the action fails, outputs are empty, and every
 *    check job skips — the exact vacuous-green shape this file exists to stop.
 *  - A job-level block REPLACES the top-level one wholesale, so `changes` — and
 *    in general any job that declares only what it additionally needs
 *    (`pages: write`, `contents: write`, …) — must restate `contents:`, or it
 *    silently drops to `contents: none` and its checkout then works only
 *    because this repository is public. On a private repo, or a fork made
 *    private, the same workflow fails at checkout. `write` satisfies the rule:
 *    it implies read, and the two release jobs legitimately need it.
 *  - actions/checkout stores the token in .git/config by default, where every
 *    later step of the job — including third-party actions and anything
 *    `pnpm install` runs — can read it. No job in this workflow runs a git
 *    network command after checkout, and the two `gh` calls (release create /
 *    release upload) take GH_TOKEN from their own step env, so nothing here
 *    needs the credential to outlive the checkout. EVERY checkout of the job is
 *    checked, not just the first: a second checkout without the opt-out
 *    re-persists the token.
 *
 * FILTER GLOBS, in detail (property 4). Containment, never equality, so a
 * legitimately added glob stays green.
 *  - `pnpm-workspace.yaml` decides which packages `pnpm install` links, so it
 *    is in every package filter that installs: `extension`, `pwa`, `worker`.
 *  - `.env.*` only in `extension` and `pwa`: both Vite configs read the root
 *    env files (`envDir: ..`), and `.env.production` is baked into the release
 *    build — a typo there must fail a PR, not the tag. The Worker never reads
 *    them.
 *  - `docker` lists the Docker files plus the manifests and lockfile, because
 *    the image installs the whole workspace and a manifest-only change can
 *    break it without touching a Docker file.
 *  - `worker-check`'s JOB-level `if:` (four-space indent, `if: >-`) must accept
 *    `needs.changes.outputs.docker`: `nodeEngineFloor.test.ts` asserts the
 *    Dockerfile's pnpm and Node versions, and lives in that job. The route is
 *    deliberately NOT the `worker` filter — that output also gates
 *    `deploy-worker-dev`, and a Dockerfile-only merge must not redeploy an
 *    unchanged Worker. Drop the clause and the Dockerfile assertions never
 *    run on the one PR that can break them.
 *
 * AMO-LISTED VISIBILITY, in detail (property 5).
 *  - `continue-on-error: true` stays: the listed submission runs after every
 *    artifact is uploaded, and an AMO review hiccup must not fail the release.
 *    It is also the positive companion of the gate's negative assertion.
 *  - `shell: bash` is load-bearing. GitHub runs an EXPLICIT `bash` as
 *    `bash --noprofile --norc -eo pipefail`; the default shell has no
 *    `pipefail`. The step pipes web-ext into `tee`, so without pipefail the
 *    pipeline's status is `tee`'s (always 0), the outcome is never `failure`,
 *    and the warning step can never fire — silently.
 *  - The follow-up must sit AFTER the submission step (a step can only read
 *    the outcome of one that already ran) and key on its `id`; a typo in
 *    either spelling makes `steps.<id>.outcome` the empty string, and the
 *    warning step skips forever. The `tee` target and the `tail` source must
 *    name the same `amo-listed.log`.
 *
 * NPX-FREE CLI CALLS (property 6).
 *  - `npx <bin>` runs `node_modules/.bin/<bin>` when the cwd's package has
 *    one. When it does not — the repo root has no web-ext or wrangler bin;
 *    each lives under its own package — npx DOWNLOADS the package instead,
 *    and in a non-TTY CI shell it never prompts first: it fetches the LATEST
 *    registry version and runs it with the step's secrets (the AMO JWT pair,
 *    the Cloudflare API token). Nothing in a green run says which version
 *    ran. The v1.7.2 release run: web-ext locked at 8.10.0 ran 10.7.0, and
 *    wrangler locked at 4.132.0 ran 4.149.0.
 *  - `pnpm exec <bin>` resolves the package's `node_modules/.bin`, then the
 *    workspace root's, then the inherited PATH, and fails only when all three
 *    miss; it never downloads. Every runner that DOES download when no local
 *    bin exists is banned alongside `npx`: `pnpx` / `pnx` (pnpm 11's `dlx`
 *    aliases), `bunx` / `bun x`, `npm exec` / `npm x` (what `npx` is), and
 *    `pnpm dlx` / `yarn dlx` — the npm / pnpm / yarn forms with flags in
 *    between, each optionally carrying one value (`pnpm --silent dlx`,
 *    `pnpm --filter <pkg> dlx`, `pnpm -C <dir> dlx`, `npm --yes exec`) — one
 *    `DOWNLOADING_RUNNER` regex, pinned by literal samples. The scan covers every
 *    non-comment line — a comment line is one whose `trim()` starts with `#`,
 *    so the workflow's own comments explaining why `npx` is gone do not trip
 *    it. Failure messages name the offending line numbers.
 *  - Positive companions, because a negative over a filtered list passes
 *    vacuously once the filter swallows everything: the non-comment line
 *    count must be above zero and below the total, at least 7 lines must use
 *    `pnpm exec` (9 today: tsc ×2, playwright ×2, tsx, web-ext lint ×2,
 *    web-ext sign ×2), and exactly 2 must run `worker/node_modules/.bin/wrangler`.
 *  - web-ext: the three Firefox steps carry a step-level
 *    `working-directory: extension`, so `pnpm exec` resolves the extension
 *    package's pinned web-ext, and their paths are relative to `extension/`.
 *    A leftover `extension/` prefix on `--source-dir` / `--artifacts-dir`
 *    would point at `extension/extension/…` and is asserted absent. The lint
 *    step's two invocations must EQUAL the two `web-ext lint …` segments of
 *    `extension/package.json`'s `lint:firefox` script, so the CI and the
 *    local spelling cannot drift apart. That manifest is read from its real
 *    path even under the mutation-check seam.
 *  - wrangler: the Pages deploys run `worker/node_modules/.bin/wrangler` from
 *    the REPO ROOT — no step-level `working-directory`, no job-level
 *    `defaults:` block. `wrangler pages deploy` reads the wrangler config of
 *    its cwd and decides from `process.cwd()` whether to delegate Pages to
 *    Workers, so running it under `worker/` — the shape `deploy-worker-dev` /
 *    `deploy-worker-prod` legitimately use through `defaults:` — would hand
 *    a PWA deploy the Worker's config. Companion to the "no `defaults:`"
 *    negative: the same `keyBlock` call must still see `deploy-worker-dev`'s
 *    block, and the "no step `working-directory:`" negative is mirrored by
 *    the Firefox steps, which must carry one at the same indentation.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mutation-check seam (`MOO_CI_WORKFLOW_PATH`; CI sets none), resolved from THIS file, not the cwd.
// See the header → "MUTATION-CHECK SEAM".
const WORKFLOW_PATH =
  process.env.MOO_CI_WORKFLOW_PATH ??
  resolve(HERE, "../../../.github/workflows/cicd.yml");

/** The aggregate gate itself — required status check, never its own dependency. */
const GATE_JOB_ID = "ci-success";

/** The path-filter job whose outputs every check job's `if:` reads. */
const CHANGES_JOB_ID = "changes";

/** Job-id prefixes that are CD, and correctly sit outside the CI gate. */
const CD_JOB_PREFIXES = ["deploy-", "release-"];

// The workflow's own path, as a path-filter glob. Every filter lists it so a
// workflow edit runs the whole pipeline — including the jobs that edit changed.
const WORKFLOW_SELF_GLOB = ".github/workflows/cicd.yml";

// --- A minimal, anchor-checked workflow reader ---

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

// Everything after the top-level `jobs:` key (the `on:` block's `  push:` is not a job).
// See the header → "THE SCAN HELPERS".
function jobsRegion(workflow: string): string {
  const match = /^jobs:[ \t]*$/m.exec(workflow);
  if (!match) {
    throw new Error("No top-level `jobs:` key found in the CI workflow.");
  }
  return workflow.slice(match.index + match[0].length);
}

// Everything BEFORE the top-level `jobs:` key; the complement of `jobsRegion`, so it
// inherits that helper's loud throw when the anchor is gone.
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

// The body of `<key>:` at `indent` spaces (`|` / `>-` block scalars tolerated); `null` when absent.
// See the header → "THE SCAN HELPERS".
function keyBlock(source: string, indent: number, key: string): string | null {
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

// --- The `changes` job: outputs, path filters, and how they are referenced ---

/** One `<key>: ${{ steps.<stepId>.outputs.<name> }}` line of a job's outputs. */
interface OutputBinding {
  /** The name the output is published under — what `needs.changes.outputs.X` reads. */
  key: string;
  /** The step the value is taken from; must be the paths-filter step. */
  stepId: string;
  /** The step output the value is taken from; must equal `key`. */
  name: string;
}

// The `changes` job's `outputs:` block parsed WHOLE (key, source step, source output); STRICT.
// See the header → "THE SCAN HELPERS".
function outputBindings(changesBlock: string): OutputBinding[] {
  const block = keyBlock(changesBlock, 4, "outputs");
  if (block === null) {
    throw new Error(
      `\`${CHANGES_JOB_ID}\` has no \`outputs:\` block — the names every ` +
        `check job's \`if:\` reads can no longer be enumerated.`,
    );
  }
  const bindings: OutputBinding[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const match =
      /^ {6}([A-Za-z0-9_-]+):[ \t]*\$\{\{[ \t]*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)[ \t]*\}\}[ \t]*$/.exec(
        line,
      );
    if (!match) {
      throw new Error(
        `Unparsable line in the \`${CHANGES_JOB_ID}\` outputs block: ` +
          `${JSON.stringify(line)}. The parser expects ` +
          `\`<key>: \${{ steps.<id>.outputs.<name> }}\`; fix the parser rather ` +
          `than letting an output go unchecked.`,
      );
    }
    bindings.push({ key: match[1], stepId: match[2], name: match[3] });
  }
  if (bindings.length === 0) {
    throw new Error(
      `\`${CHANGES_JOB_ID}.outputs\` parsed to zero names — the scan drifted ` +
        `and every comparison against it would be vacuous.`,
    );
  }
  return bindings;
}

/** The `id:` of the `dorny/paths-filter` step — what its outputs are read under. */
function pathsFilterStepId(changesBlock: string): string {
  const start = /^ {6}- uses: dorny\/paths-filter@.*$/m.exec(changesBlock);
  if (!start) {
    throw new Error(
      `No \`dorny/paths-filter\` step in the \`${CHANGES_JOB_ID}\` job — the ` +
        `step its outputs are read from can no longer be identified.`,
    );
  }
  const rest = changesBlock.slice(start.index + start[0].length);
  const next = /^ {6}- /m.exec(rest);
  const step = next ? rest.slice(0, next.index) : rest;
  const id = /^ {8}id:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/m.exec(step);
  if (!id) {
    throw new Error(
      `The \`dorny/paths-filter\` step has no \`id:\` — every ` +
        `\`steps.<id>.outputs.*\` reference in \`outputs:\` is then dead.`,
    );
  }
  return id[1];
}

// The `dorny/paths-filter` `filters:` block as `name -> globs`; STRICT (unknown lines throw).
// See the header → "THE SCAN HELPERS".
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

// --- Steps: every actions/checkout in the file ---

// EVERY `actions/checkout` step slice in `source`, in file order (a second checkout counts).
// See the header → "THE SCAN HELPERS".
function checkoutSteps(source: string): string[] {
  const starts = [...source.matchAll(/^ {6}- uses: actions\/checkout@.*$/gm)];
  return starts.map((start) => {
    const rest = source.slice((start.index ?? 0) + start[0].length);
    const next = /^ {6}- /m.exec(rest);
    return start[0] + (next ? rest.slice(0, next.index) : rest);
  });
}

/** Every step slice of one job block, in file order; throws when the job has none. */
function jobSteps(block: string, jobId: string): string[] {
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
function stepIndexNamed(steps: string[], name: string): number {
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

// --- Derived values ---

const JOB_IDS = jobIds(WORKFLOW);
const CI_JOB_IDS = ciJobIds(JOB_IDS);
const GATE_BLOCK = jobBlock(WORKFLOW, GATE_JOB_ID);
const GATE_NEEDS = needsList(GATE_BLOCK);
const GATE_RESULT_REFS = resultRefs(GATE_BLOCK);

const CHECKOUT_STEPS = checkoutSteps(WORKFLOW);
// Every line that USES actions/checkout, in EITHER step spelling; comment lines never match.
// See the header → "THE SCAN HELPERS".
const CHECKOUT_USES_LINES = [
  ...WORKFLOW.matchAll(/^[ \t]*(?:- )?uses: actions\/checkout@/gm),
];
/** Every job that checks out at all — CI and CD alike; the rule covers both. */
const JOB_IDS_WITH_CHECKOUT = JOB_IDS.filter(
  (id) => checkoutSteps(jobBlock(WORKFLOW, id)).length > 0,
);

// Checkout jobs declaring their OWN `permissions:` block (no longer inheriting `contents: read`);
// a job without a block is exempt by construction.
const JOBS_WITH_OWN_PERMISSIONS = JOB_IDS_WITH_CHECKOUT.filter(
  (id) => keyBlock(jobBlock(WORKFLOW, id), 4, "permissions") !== null,
);

const CHANGES_BLOCK = jobBlock(WORKFLOW, CHANGES_JOB_ID);
const PATH_FILTERS = pathFilters(CHANGES_BLOCK);
const FILTER_NAMES = nameSet([...PATH_FILTERS.keys()]);
const OUTPUT_BINDINGS = outputBindings(CHANGES_BLOCK);
const OUTPUT_KEYS = nameSet(OUTPUT_BINDINGS.map((binding) => binding.key));
const PATHS_FILTER_STEP_ID = pathsFilterStepId(CHANGES_BLOCK);
const OUTPUT_REF_NAMES = nameSet(outputRefNames(WORKFLOW));

// The jobs the scan MUST see (containment) — companion to the "every CI job is in the gate" cases.
// See the header → "THE POSITIVE COMPANIONS".
const EXPECTED_CI_JOB_IDS = [
  "changes",
  "extension-check",
  "worker-check",
  "pwa-check",
  "e2e",
  "pwa-e2e",
  "format",
  "audit",
  "docker",
];
const EXPECTED_CD_JOB_IDS = ["deploy-worker-dev", "release-extension"];

// Companion to the three-way set equality (three EMPTY sets compare equal); containment.
// See the header → "THE POSITIVE COMPANIONS".
const EXPECTED_FILTER_NAMES = ["extension", "pwa", "worker", "docker"];

// A floor on `actions/checkout` steps: one per CI job (9) plus one per CD job (7).
// See the header → "THE POSITIVE COMPANIONS".
const EXPECTED_CHECKOUT_COUNT = 16;

// Globs each filter must contain (containment); each guards a change class no package dir covers.
// See the header → "FILTER GLOBS, in detail".
const EXPECTED_FILTER_GLOBS: ReadonlyArray<[string, readonly string[]]> = [
  ["extension", ["pnpm-workspace.yaml", ".env.*"]],
  ["pwa", ["pnpm-workspace.yaml", ".env.*"]],
  ["worker", ["pnpm-workspace.yaml"]],
  [
    "docker",
    [
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
  ],
];

/** The job whose tests include the Dockerfile version assertions (nodeEngineFloor.test.ts). */
const WORKER_CHECK_JOB_ID = "worker-check";

/** The job holding the non-blocking AMO-listed submission and its failure warning. */
const FIREFOX_RELEASE_JOB_ID = "release-extension-firefox";
const AMO_LISTED_STEP_NAME = "Sign & submit to AMO (listed)";
const AMO_LISTED_STEP_ID = "amo-listed";
const AMO_LISTED_LOG = "amo-listed.log";

// The checkout jobs that override the token scope today — companion to "restate contents:".
// See the header → "THE POSITIVE COMPANIONS".
const EXPECTED_JOBS_WITH_OWN_PERMISSIONS = [
  "changes",
  "deploy-pages",
  "release-extension",
  "release-extension-firefox",
];

// --- npx-free CLI calls (property 6) ---

/** The extension manifest whose `lint:firefox` script the CI lint step must mirror. */
const EXTENSION_PACKAGE_PATH = resolve(HERE, "../../../extension/package.json");

/** The worker's lockfile-pinned wrangler, run from the repo root by the Pages deploys. */
const WORKER_WRANGLER_BIN = "worker/node_modules/.bin/wrangler";

// Floors for the npx ban's positive companions: 9 `pnpm exec` lines today, 2 wrangler-bin lines.
// See the header → "NPX-FREE CLI CALLS".
const EXPECTED_PNPM_EXEC_FLOOR = 7;
const EXPECTED_WRANGLER_BIN_LINES = 2;

// npx / pnpx / pnx / bunx, `bun x`, `npm … exec|x` and `pnpm|yarn … dlx` (flags may carry one value) all download.
const FLAGS = String.raw`(?:-\S+(?:\s+[^-\s]\S*)?\s+)*`;
const DOWNLOADING_RUNNER = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])(?:npx|pnpx|pnx|bunx)([^A-Za-z0-9_-]|$)` +
    String.raw`|\bnpm\s+${FLAGS}(?:exec|x)(?=\s|$)|\bbun\s+x(?=\s|$)` +
    String.raw`|\b(?:pnpm|yarn)\s+${FLAGS}dlx(?=\s|$)`,
);

const WEB_EXT_LINT_STEP_NAME = "web-ext lint (both variants)";
const WEB_EXT_UNLISTED_STEP_NAME = "Sign direct-install (unlisted)";

/** Each Firefox web-ext step and the extension-relative arguments its `run:` must carry. */
const WEB_EXT_STEP_ARGS: ReadonlyArray<[string, readonly string[]]> = [
  [
    WEB_EXT_LINT_STEP_NAME,
    [
      "--source-dir=dist-firefox-amo",
      "--source-dir=dist-firefox-direct --self-hosted",
    ],
  ],
  [
    WEB_EXT_UNLISTED_STEP_NAME,
    [
      "--source-dir=dist-firefox-direct",
      "--artifacts-dir=web-ext-artifacts-direct",
    ],
  ],
  [
    AMO_LISTED_STEP_NAME,
    ["--source-dir=dist-firefox-amo", "--artifacts-dir=web-ext-artifacts-amo"],
  ],
];

/** The Pages deploy jobs and their deploy step, which must run from the repo root. */
const PWA_DEPLOY_STEPS: ReadonlyArray<[string, string]> = [
  ["deploy-pwa-dev", "Deploy to Cloudflare Pages (Dev)"],
  ["deploy-pwa-prod", "Deploy to Cloudflare Pages (Prod)"],
];

/** A worker deploy job whose `defaults:` block is legitimate — the companion of "no defaults". */
const WORKER_DEPLOY_JOB_ID = "deploy-worker-dev";

/** One numbered line of the workflow. */
interface NumberedLine {
  /** 1-based, as an editor shows it. */
  lineNo: number;
  text: string;
}

/** Every line of `source`, numbered, minus YAML comment lines (`trim()` starts with `#`). */
function nonCommentLines(source: string): NumberedLine[] {
  return source
    .split("\n")
    .map((text, index) => ({ lineNo: index + 1, text }))
    .filter(({ text }) => !text.trim().startsWith("#"));
}

/** The ONE step named `stepName` in job `jobId`; throws via `stepIndexNamed` when absent. */
function namedStep(workflow: string, jobId: string, stepName: string): string {
  const steps = jobSteps(jobBlock(workflow, jobId), jobId);
  return steps[stepIndexNamed(steps, stepName)];
}

/** A step's `run:` script — inline value or `|` / `>-` block body; throws when absent or empty. */
function stepRun(step: string, stepName: string): string {
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

/** The `web-ext lint …` segments of `extension/package.json`'s `lint:firefox` script. */
function lintFirefoxInvocations(path: string): string[] {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.["lint:firefox"];
  if (typeof script !== "string") {
    throw new Error(`No \`lint:firefox\` script in ${path}.`);
  }
  const segments = script
    .split("&&")
    .map((segment) => segment.trim())
    .filter((segment) => segment.startsWith("web-ext lint "));
  if (segments.length === 0) {
    throw new Error(
      `\`lint:firefox\` in ${path} holds no \`web-ext lint\` segment — the ` +
        `CI lint step would be compared against nothing.`,
    );
  }
  return segments;
}

describe("ci-success gate in .github/workflows/cicd.yml", () => {
  it("reads the workflow from a path that exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
    expect(WORKFLOW).toContain("name: CI Success");
  });

  it("finds the pipeline's job ids and no trigger keys from the on: block", () => {
    for (const id of [...EXPECTED_CI_JOB_IDS, ...EXPECTED_CD_JOB_IDS]) {
      expect(JOB_IDS).toContain(id);
    }
    // `  push:` / `  pull_request:` sit in `on:` at job-key indentation; picking them up means the
    // scan is not scoped to the jobs region and the CI/CD partition is meaningless.
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
    // `always()` decides the gate reports at all; four-space indent = the JOB-level `if:`.
    // See the header → "GATE ENFORCEMENT, in detail".
    expect(GATE_BLOCK).toMatch(/^ {4}if:\s*\$\{\{\s*always\(\)\s*\}\}[ \t]*$/m);
  });
});

describe("ci-success gate enforcement step", () => {
  it("fails the run on a failure or cancelled result", () => {
    // The COMBINED condition pinned as one whole line (`||` → `&&` would pass a fragment match).
    // See the header → "GATE ENFORCEMENT, in detail".
    expect(GATE_BLOCK).toMatch(
      /^[ \t]*if[ \t]+\[[ \t]+"\$r"[ \t]+=[ \t]+"failure"[ \t]+\][ \t]*\|\|[ \t]*\[[ \t]+"\$r"[ \t]+=[ \t]+"cancelled"[ \t]+\][ \t]*;[ \t]*then[ \t]*$/m,
    );
    expect(GATE_BLOCK).toMatch(/^\s*exit 1[ \t]*$/m);
  });

  it("never marks the gate or its step continue-on-error", () => {
    // `continue-on-error` reports SUCCESS whatever the exit code; nothing in the gate's block
    // may carry it, job-level or step-level.
    expect(GATE_BLOCK).not.toContain("continue-on-error");
  });

  it("still finds continue-on-error elsewhere in the workflow", () => {
    // Positive companion: release-extension-firefox's AMO-listed step is deliberately non-blocking.
    // See the header → "GATE ENFORCEMENT, in detail".
    expect(WORKFLOW).toContain("continue-on-error");
  });
});

describe("changes job path filters", () => {
  it.each(FILTER_NAMES)(
    "makes a change to the workflow itself trigger the %s filter",
    (filterName) => {
      // Every filter lists the workflow file, so any change to cicd.yml runs the whole pipeline.
      // See the header → "NAME CONSISTENCY, in detail".
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
    // Three independent spellings, validated by nothing in Actions: a mismatch yields "",
    // `== 'true'` is false, and the job SKIPS with no error — which the gate accepts.
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

  it("wires every output to the paths-filter step's matching output", () => {
    // The output VALUE is a fourth spelling; a typo there publishes "" and every gated job skips.
    // See the header → "NAME CONSISTENCY, in detail".
    expect(
      PATHS_FILTER_STEP_ID.length,
      "No usable `id:` on the dorny/paths-filter step; the assertions below " +
        "would compare every output against an empty step id.",
    ).toBeGreaterThan(0);
    expect(OUTPUT_BINDINGS.length).toBeGreaterThan(0);
    for (const binding of OUTPUT_BINDINGS) {
      expect(
        binding.name,
        `\`${CHANGES_JOB_ID}.outputs.${binding.key}\` reads the step output ` +
          `\`${binding.name}\`, which is not the filter of the same name.`,
      ).toBe(binding.key);
      expect(
        binding.stepId,
        `\`${CHANGES_JOB_ID}.outputs.${binding.key}\` reads from step ` +
          `\`${binding.stepId}\`, but the paths-filter step's id is ` +
          `\`${PATHS_FILTER_STEP_ID}\` — the reference resolves to "".`,
      ).toBe(PATHS_FILTER_STEP_ID);
    }
  });
});

describe("workflow token permissions", () => {
  it("declares a read-only default at the top level, above jobs:", () => {
    // Absent it, every job's GITHUB_TOKEN inherits the (possibly read-write) default; it must sit
    // ABOVE `jobs:`. See the header → "TOKEN PERMISSIONS, in detail".
    const block = keyBlock(preJobsRegion(WORKFLOW), 0, "permissions");
    expect(
      block,
      "No top-level `permissions:` block above `jobs:` — every job would " +
        "inherit the repository's default GITHUB_TOKEN scope.",
    ).not.toBeNull();
    expect(block).toMatch(/^ {2}contents:[ \t]*read[ \t]*$/m);
  });

  it("grants the changes job the pull-requests read it needs", () => {
    // `dorny/paths-filter` needs `pull-requests: read`, or every check job skips (vacuous green).
    // See the header → "TOKEN PERMISSIONS, in detail".
    const block = keyBlock(CHANGES_BLOCK, 4, "permissions");
    expect(
      block,
      "No `permissions:` block in the `changes` job — dorny/paths-filter " +
        "cannot read the pull request's changed files under a read-only " +
        "top-level default.",
    ).not.toBeNull();
    expect(block).toMatch(/^ {6}pull-requests:[ \t]*read[ \t]*$/m);
    // A job-level block REPLACES the top-level one, so `contents: read` is restated here —
    // without it this job has no repository read and the checkout fails.
    expect(block).toMatch(/^ {6}contents:[ \t]*read[ \t]*$/m);
  });

  it("finds the checkout jobs that declare their own permissions block", () => {
    // Positive companion: if `keyBlock` stopped matching a job-level `permissions:`, the rule
    // below would run zero cases while staying green.
    for (const jobId of EXPECTED_JOBS_WITH_OWN_PERMISSIONS) {
      expect(JOBS_WITH_OWN_PERMISSIONS).toContain(jobId);
    }
  });

  it.each(JOBS_WITH_OWN_PERMISSIONS)(
    "keeps repository read in %s's own permissions block",
    (jobId) => {
      // General form of the `changes` case: restate `contents:` (`write` satisfies it).
      // See the header → "TOKEN PERMISSIONS, in detail".
      const block = keyBlock(jobBlock(WORKFLOW, jobId), 4, "permissions");
      expect(block).not.toBeNull();
      expect(block).toMatch(/^ {6}contents:[ \t]*(read|write)[ \t]*$/m);
    },
  );

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
    // Positive companion: a step regex matching nothing makes "every checkout opts out" vacuous
    // (both counts zero satisfy the equality above — this floor catches that).
    expect(CHECKOUT_STEPS.length).toBeGreaterThanOrEqual(
      EXPECTED_CHECKOUT_COUNT,
    );
    for (const jobId of CI_JOB_IDS) {
      expect(checkoutSteps(jobBlock(WORKFLOW, jobId)).length).toBeGreaterThan(
        0,
      );
    }
  });

  // Driven off the jobs that actually check out, so a new CI or CD job inherits the rule;
  // the case above stops that list from silently shrinking to nothing.
  it.each(JOB_IDS_WITH_CHECKOUT)(
    "checks out %s without persisting credentials",
    (jobId) => {
      // actions/checkout persists the token in .git/config by default; EVERY checkout is checked.
      // See the header → "TOKEN PERMISSIONS, in detail".
      const steps = checkoutSteps(jobBlock(WORKFLOW, jobId));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step).toMatch(/^\s+persist-credentials:[ \t]*false[ \t]*$/m);
      }
    },
  );
});

describe("changes job path filter globs", () => {
  it.each(EXPECTED_FILTER_GLOBS)(
    "lists the expected globs in the %s filter",
    (filterName, globs) => {
      // A dropped glob skips that package's checks on the very PR that needed them.
      // See the header → "FILTER GLOBS, in detail".
      const actual = PATH_FILTERS.get(filterName);
      expect(
        actual,
        `No \`${filterName}\` filter in the \`${CHANGES_JOB_ID}\` job.`,
      ).toBeDefined();
      for (const glob of globs) {
        expect(
          actual,
          `\`${filterName}\` filter must list '${glob}'`,
        ).toContain(glob);
      }
    },
  );

  it("lets the docker filter trigger worker-check via its job-level if:", () => {
    // nodeEngineFloor.test.ts's Dockerfile checks must run on a Dockerfile-only PR, but not via
    // `worker` (it also gates deploy-worker-dev). See the header → "FILTER GLOBS, in detail".
    const condition = keyBlock(
      jobBlock(WORKFLOW, WORKER_CHECK_JOB_ID),
      4,
      "if",
    );
    expect(
      condition,
      `\`${WORKER_CHECK_JOB_ID}\` has no job-level \`if:\` block to read.`,
    ).not.toBeNull();
    expect(condition).toMatch(
      new RegExp(
        `needs\\.${CHANGES_JOB_ID}\\.outputs\\.docker[ \\t]*==[ \\t]*'true'`,
      ),
    );
  });
});

describe("AMO listed submission warning", () => {
  it("keeps the listed submission non-blocking, under bash, behind a step id", () => {
    // `shell: bash` gives `-eo pipefail`; without it `tee` masks web-ext's exit code and the
    // outcome is never `failure`. See the header → "AMO-LISTED VISIBILITY, in detail".
    const steps = jobSteps(
      jobBlock(WORKFLOW, FIREFOX_RELEASE_JOB_ID),
      FIREFOX_RELEASE_JOB_ID,
    );
    const step = steps[stepIndexNamed(steps, AMO_LISTED_STEP_NAME)];
    expect(step).toMatch(
      new RegExp(`^ {8}id:[ \\t]*${AMO_LISTED_STEP_ID}[ \\t]*$`, "m"),
    );
    expect(step).toMatch(/^ {8}shell:[ \t]*bash[ \t]*$/m);
    expect(step).toMatch(/^ {8}continue-on-error:[ \t]*true[ \t]*$/m);
    expect(step).toMatch(/\|[ \t]*tee[ \t]+\S*amo-listed\.log/);
  });

  it("follows it with a warning step keyed on its failure outcome", () => {
    // A step keyed on `steps.<id>.outcome` must run AFTER that step, or it reads "".
    // See the header → "AMO-LISTED VISIBILITY, in detail".
    const steps = jobSteps(
      jobBlock(WORKFLOW, FIREFOX_RELEASE_JOB_ID),
      FIREFOX_RELEASE_JOB_ID,
    );
    const listedIndex = stepIndexNamed(steps, AMO_LISTED_STEP_NAME);
    const outcomeIf = new RegExp(
      `^ {8}if:.*steps\\.${AMO_LISTED_STEP_ID}\\.outcome[ \\t]*==[ \\t]*'failure'`,
      "m",
    );
    const warnIndex = steps.findIndex((step) => outcomeIf.test(step));
    expect(
      warnIndex,
      `No step in \`${FIREFOX_RELEASE_JOB_ID}\` has an \`if:\` on ` +
        `\`steps.${AMO_LISTED_STEP_ID}.outcome == 'failure'\` — a failed ` +
        `listed submission would leave a green run and no trace.`,
    ).toBeGreaterThanOrEqual(0);
    expect(warnIndex).toBeGreaterThan(listedIndex);
    const warnStep = steps[warnIndex];
    expect(warnStep).toContain("::warning::");
    expect(warnStep).toContain(AMO_LISTED_LOG);
    expect(warnStep).toMatch(/\btail\b.*amo-listed\.log/);
  });
});

describe("npx-free CLI calls", () => {
  const LINES = nonCommentLines(WORKFLOW);
  const TOTAL_LINES = WORKFLOW.split("\n").length;

  it("runs no CLI through a downloading runner on any non-comment line", () => {
    // Each downloads the LATEST registry version when no local bin exists, and runs it with secrets.
    // See the header → "NPX-FREE CLI CALLS".
    const offenders = LINES.filter(({ text }) =>
      DOWNLOADING_RUNNER.test(text),
    ).map(({ lineNo, text }) => `${lineNo}: ${text.trim()}`);
    expect(
      offenders,
      `cicd.yml still runs a CLI through a downloading runner on line(s):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("recognises every downloading runner and no pinned or look-alike form", () => {
    // Positive companion for the ban's regex. See the header → "NPX-FREE CLI CALLS".
    const downloading = [
      "npx tsc",
      "pnpx web-ext",
      "pnx web-ext",
      "bunx web-ext",
      "bun x web-ext",
      "npm exec web-ext",
      "npm x web-ext",
      "npm --yes exec web-ext",
      "pnpm dlx web-ext",
      "pnpm --silent dlx web-ext",
      "pnpm --filter a dlx web-ext",
      "pnpm -C extension dlx web-ext",
      "yarn dlx web-ext",
    ];
    const notDownloading = [
      "pnpm exec web-ext lint",
      "pnpm --filter a exec tsc",
      "pnpm --filter a exec dlx",
      "npm exec-foo",
      "npm run x",
      "some-npx-tool",
      "-npx-",
      "npxify",
    ];
    expect(downloading.filter((s) => !DOWNLOADING_RUNNER.test(s))).toEqual([]);
    expect(notDownloading.filter((s) => DOWNLOADING_RUNNER.test(s))).toEqual(
      [],
    );
  });

  it("still sees the pinned CLI calls the npx ban replaced", () => {
    // Positive companion: the comment filter must not swallow the file, and the pinned forms exist.
    // See the header → "NPX-FREE CLI CALLS".
    expect(LINES.length).toBeGreaterThan(0);
    expect(LINES.length).toBeLessThan(TOTAL_LINES);
    const pnpmExec = LINES.filter(({ text }) => /\bpnpm exec\b/.test(text));
    expect(pnpmExec.length).toBeGreaterThanOrEqual(EXPECTED_PNPM_EXEC_FLOOR);
    const wranglerBin = LINES.filter(({ text }) =>
      text.includes(WORKER_WRANGLER_BIN),
    );
    expect(wranglerBin.length).toBe(EXPECTED_WRANGLER_BIN_LINES);
  });

  it.each(WEB_EXT_STEP_ARGS)(
    "runs the pinned web-ext from extension/ in step %s",
    (stepName, args) => {
      // Step-level working-directory makes `pnpm exec` resolve extension's web-ext; paths are relative.
      // See the header → "NPX-FREE CLI CALLS".
      const step = namedStep(WORKFLOW, FIREFOX_RELEASE_JOB_ID, stepName);
      expect(step).toMatch(/^ {8}working-directory:[ \t]*extension[ \t]*$/m);
      const run = stepRun(step, stepName);
      expect(run).toContain("pnpm exec web-ext");
      for (const arg of args) {
        expect(run, `\`${stepName}\` must pass ${arg}`).toContain(arg);
      }
      // Relative to extension/ now, so an `extension/` prefix would resolve to extension/extension/.
      expect(step).not.toContain("--source-dir=extension/");
      expect(step).not.toContain("--artifacts-dir=extension/");
    },
  );

  it("lints the Firefox variants exactly as extension's lint:firefox script does", () => {
    // Two spellings of one lint run; equality keeps CI and local from drifting apart.
    // See the header → "NPX-FREE CLI CALLS".
    const run = stepRun(
      namedStep(WORKFLOW, FIREFOX_RELEASE_JOB_ID, WEB_EXT_LINT_STEP_NAME),
      WEB_EXT_LINT_STEP_NAME,
    );
    const ciInvocations = run
      .split("\n")
      .map((line) => /^pnpm exec (web-ext lint\b.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1].trim());
    expect(ciInvocations).toEqual(
      lintFirefoxInvocations(EXTENSION_PACKAGE_PATH),
    );
  });

  it("still sees the worker deploy's legitimate defaults block", () => {
    // Positive companion of "no defaults:" below: the same keyBlock call must find a real one.
    const block = keyBlock(
      jobBlock(WORKFLOW, WORKER_DEPLOY_JOB_ID),
      4,
      "defaults",
    );
    expect(block).not.toBeNull();
    expect(block).toMatch(/^ {8}working-directory:[ \t]*worker[ \t]*$/m);
  });

  it.each(PWA_DEPLOY_STEPS)("gives %s no job-level defaults block", (jobId) => {
    // `defaults: run: working-directory: worker` would run pages deploy under worker/'s config.
    // See the header → "NPX-FREE CLI CALLS".
    expect(keyBlock(jobBlock(WORKFLOW, jobId), 4, "defaults")).toBeNull();
  });

  it.each(PWA_DEPLOY_STEPS)(
    "runs the worker's pinned wrangler in %s's step %s",
    (jobId, stepName) => {
      const run = stepRun(namedStep(WORKFLOW, jobId, stepName), stepName);
      expect(run).toContain(`${WORKER_WRANGLER_BIN} pages deploy pwa/dist`);
    },
  );

  it.each(PWA_DEPLOY_STEPS)(
    "runs %s's step %s from the repo root",
    (jobId, stepName) => {
      // pages deploy reads the cwd's wrangler config; the Firefox steps mirror this selector positively.
      // See the header → "NPX-FREE CLI CALLS".
      const step = namedStep(WORKFLOW, jobId, stepName);
      expect(step).not.toMatch(/^ {8}working-directory:/m);
    },
  );
});
