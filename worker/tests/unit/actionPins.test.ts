/**
 * Every `uses:` in `.github/workflows/` pinned to a commit SHA (tripwire).
 *
 * WHY A TEST READS THE WORKFLOW FILES. A `uses:` reference written as a
 * MUTABLE tag (`actions/checkout@v5`) or a branch (`@main`) hands the action's
 * owner — and anyone who compromises their account, their npm supply chain, or
 * their release automation — the ability to change what this repository
 * executes, retroactively, with no commit here and no review. The tag is
 * re-pointed upstream and the very next CI run fetches different code under
 * the same spelling. That code runs inside jobs that hold `contents: write`
 * (the release jobs) and next to the Cloudflare deploy secrets, so the blast
 * radius is the whole pipeline. GitHub validates none of this: a tag, a
 * branch, a moving `@v1` major alias and a full SHA are equally valid syntax,
 * so nothing in a green run says which one was used. A SHA is immutable —
 * changing it requires a commit in THIS repo, which is reviewable.
 *
 * WHAT IT PINS. One property, over EVERY workflow file in the directory
 * (enumerated with `readdirSync`, never a hard-coded list — a new workflow
 * file inherits the rule the moment it lands, which is the whole point of not
 * naming them):
 *
 *     uses: <owner>/<repo>[/<path>]@<40 lowercase hex>   # v<tag>
 *
 * The version COMMENT is half the property, not decoration. A bare SHA is
 * unreadable: nobody can tell `actions/checkout@08eba0b...` from a downgrade
 * to a two-year-old release, so without the comment the safe thing (bumping a
 * pin deliberately) becomes the expensive thing and pins rot in place. The
 * comment records the tag the SHA was resolved from, which is what makes a
 * later `@v6` bump a one-line reviewable diff.
 *
 * THE SECOND PROPERTY, and why it lives in this file. A frozen SHA needs a
 * bumper, so `.github/dependabot.yml` opens a weekly `github-actions` PR that
 * moves each SHA and rewrites its `# v<tag>` comment. Those PRs arrive as
 * `pull_request` events from `dependabot[bot]`, which GitHub deliberately
 * starves: no Actions secrets, a forced read-only `GITHUB_TOKEN`. The Claude
 * review workflow needs both, so on a Dependabot PR it fails before the model
 * call and leaves a red X on every weekly bump — noise on exactly the PRs that
 * keep the pins fresh, until someone starts ignoring the X. The review job's
 * `if:` must therefore exclude that author. It is pinned HERE rather than in a
 * file of its own because it is the same feature: the pin rule creates the
 * Dependabot PRs, and this is what keeps them clean.
 *
 * HOW IT AVOIDS PASSING VACUOUSLY. The rule is a per-reference assertion, so a
 * drifted `uses:` regex — or a moved directory — would satisfy it over an
 * EMPTY scan while pinning nothing. Four things stop that: the directory's
 * existence is asserted and `listWorkflowFiles` throws loudly rather than
 * returning `[]`; the known workflow files must all be found; the total number
 * of parsed references must clear `EXPECTED_USES_COUNT` (a floor, in the shape
 * of `ciSuccessGate.test.ts`'s `EXPECTED_CHECKOUT_COUNT`); and the actions the
 * pipeline is built on must appear by name, so a regex that matched only, say,
 * the `- uses:` spelling cannot go green over the `uses:`-after-`name:` half
 * of the file.
 *
 * EXEMPTIONS, deliberately explicit. A local action (`uses: ./…`, `uses: ../…`)
 * lives in this repository and is already covered by review; a `docker://`
 * reference names an image, not a git ref, and has no SHA to pin in this
 * syntax. Neither form exists in the workflows today — both are exempted
 * anyway, and the exemption is itself pinned by a case below, so the first one
 * added does not go red for the wrong reason and send someone hunting for a
 * SHA that cannot exist.
 *
 * KNOWN BOUNDARY, so this is not read as more than it is. It is a TEXT scan of
 * `uses:` lines: an action reached some other way is invisible to it. It
 * checks that the ref IS a 40-character lowercase hex string and that a
 * version comment sits beside it — it cannot check that the SHA is the one the
 * named tag actually points at, nor that the SHA exists at all, nor that the
 * commit is on a release branch. Resolving that needs a network call to
 * GitHub, which a unit test must not make; a wrong-but-well-formed pin is
 * caught by review of the one-line diff, not here. The comment's shape is
 * checked as a PREFIX (`# v1.2.3`, `# v1.2.3 — bumped 2026-09`), so trailing
 * prose is allowed and only a missing or non-version comment is red.
 *
 * CI REACHABILITY (.claude/rules/test.md → "Cross-package parity tests must be
 * CI-reachable"): this guard lives in `worker-check`, so it runs only when
 * `.github/workflows/cicd.yml` → `changes.worker` matches the change. That
 * filter must list `.github/workflows/**` — NOT just `cicd.yml` — or an edit
 * to `claude.yml` / `claude-code-review.yml` (exactly the change class that
 * un-pins an action) never runs this file. Narrowing that glob back silently
 * blinds the guard on two of the three workflows it covers.
 *
 * No YAML library is used: neither `yaml` nor `js-yaml` is resolvable in this
 * workspace, and a new dependency is a non-goal
 * (`.claude/rules/change-triage.md`). Same grep-shaped house style as
 * `worker/tests/unit/ciSuccessGate.test.ts`.
 *
 * MUTATION-CHECKED at authoring time (test.md → "Guard tests must prove they
 * can fail"): driven through the seam below against throwaway fixture
 * workflows — a ref back to `@v5` goes RED naming file and line, a 40-hex ref
 * whose `# v…` comment was removed goes RED, a 39-character and an uppercase
 * ref go RED, an added `uses: ./local-action` stays GREEN, and deleting every
 * `uses:` line goes RED on the count floor. For the Dependabot half: dropping
 * the author condition goes RED even when a COMMENTED-OUT copy of it is left
 * behind in the file, and removing `dependabot.yml` from the fixture's parent
 * goes RED on the companion.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * MUTATION-CHECK SEAM (same device as `ciSuccessGate.test.ts`'s
 * `MOO_CI_WORKFLOW_PATH` and `nodeEngineFloor.test.ts`'s package.json paths).
 * The directory is overridable purely so this guard can be driven RED against
 * throwaway fixture workflows at authoring time, WITHOUT editing the live
 * `.github/workflows/` files. CI sets no such variable. A seam value pointing
 * at NOTHING throws loudly in `listWorkflowFiles` below; a seam value pointing
 * at a VALID fixture directory is the intended mutation-check use, and the
 * guard then scans those fixtures rather than the repo's workflows, undetected.
 *
 * Resolved from THIS file, not `process.cwd()`: vitest runs with the `worker/`
 * package as its cwd, and `.github/` sits two levels above it.
 */
const WORKFLOWS_DIR =
  process.env.MOO_WORKFLOWS_DIR ?? resolve(HERE, "../../../.github/workflows");

/**
 * The workflows that exist today. Containment, not equality — a new workflow
 * file is legitimate and the rule covers it automatically. Positive companion:
 * without this, a seam or a rename that emptied the scan would make every
 * per-reference assertion vacuously true.
 */
const EXPECTED_WORKFLOW_FILES = [
  "cicd.yml",
  "claude-code-review.yml",
  "claude.yml",
];

/**
 * How many `uses:` references the scan must find: 42 in `cicd.yml`, 2 in
 * `claude-code-review.yml`, 2 in `claude.yml`. A FLOOR, not an equality —
 * adding a step is legitimate, and the pin rule then covers it. This is what
 * catches a drifted `uses:` pattern that matches nothing.
 */
const EXPECTED_USES_COUNT = 46;

/**
 * Actions the pipeline is built on. Second positive companion, aimed at a
 * PARTIALLY drifted pattern rather than a fully dead one: `dorny/paths-filter`
 * and `pnpm/action-setup` are only ever written in the `- uses:` list form,
 * `anthropics/claude-code-action` only in the `name:`-then-`uses:` form, so a
 * pattern that lost either spelling drops one of these and goes red here
 * instead of quietly skipping those references.
 */
const REQUIRED_ACTIONS = [
  "actions/checkout",
  "pnpm/action-setup",
  "dorny/paths-filter",
  "anthropics/claude-code-action",
];

/** Workflow files, as GitHub Actions accepts them. */
const WORKFLOW_FILE_PATTERN = /\.ya?ml$/;

/** A line whose first non-space character is `#` — commentary, never a step. */
const COMMENT_LINE_PATTERN = /^[ \t]*#/;

/**
 * A `uses:` step line, in both spellings the workflows use: `- uses: x` (the
 * first key of a step) and `uses: x` (a later key, after `name:` / `if:`).
 * Group 1 is the reference, group 2 the remainder of the line — where the
 * version comment must be. Anchored at the indent so a key merely ENDING in
 * `uses:` (`reuses:`) cannot match.
 */
const USES_LINE_PATTERN = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*(\S+)[ \t]*(.*)$/;

/** `<owner>/<repo>[/<path>]@<40 lowercase hex>` — the only accepted shape. */
const PINNED_REF_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/;

/** The tag the SHA was resolved from, as a trailing comment. */
const VERSION_COMMENT_PATTERN = /^#[ \t]*v\d+(?:\.\d+)*\b/;

/** An action stored in this repository — reviewed here, nothing to pin. */
const LOCAL_REF_PATTERN = /^\.{1,2}\//;

/** A container image, not a git ref — this syntax has no SHA to carry. */
const DOCKER_REF_PATTERN = /^docker:\/\//;

/**
 * Dependabot's config, beside the workflows directory rather than inside it.
 * Resolved from `WORKFLOWS_DIR` so the mutation seam reaches it too.
 */
const DEPENDABOT_CONFIG = resolve(WORKFLOWS_DIR, "../dependabot.yml");

/** The ecosystem whose weekly PRs the review job must skip. */
const GITHUB_ACTIONS_ECOSYSTEM = 'package-ecosystem: "github-actions"';

/** The workflow whose job-level `if:` carries the author condition. */
const REVIEW_WORKFLOW_FILE = "claude-code-review.yml";

/**
 * The author condition, tolerant of spacing and of either quote style — the
 * spelling is what matters, not the formatting a future edit lands on.
 */
const DEPENDABOT_SKIP_PATTERN = /user\.login\s*!=\s*['"]dependabot\[bot\]['"]/;

/** A block-scalar `if:` key — `if: >-`, `if: |`, `if: >`. */
const BLOCK_IF_PATTERN = /^([ \t]*)if:[ \t]*[>|][-+]?[ \t]*$/m;

/** One `uses:` reference, located precisely enough to name in a failure. */
interface UsesReference {
  /** Workflow file name, e.g. `cicd.yml`. */
  readonly file: string;
  /** 1-based line number within that file. */
  readonly line: number;
  /** The reference itself, unquoted. */
  readonly value: string;
  /** Whatever followed it on the same line, trimmed (`""` when nothing did). */
  readonly comment: string;
}

/**
 * The workflow files in `dir`, sorted for a stable case order. Throws rather
 * than returning an empty list: "the directory is gone" is a broken guard, not
 * a satisfied one.
 */
function listWorkflowFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(
      `Workflow directory not found at ${dir}. This guard is only meaningful ` +
        `while it reads the real files — update the path instead of letting ` +
        `the assertions pass over an empty scan.`,
    );
  }
  const files = readdirSync(dir)
    .filter((name) => WORKFLOW_FILE_PATTERN.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `No .yml/.yaml files found in ${dir}. Every workflow must be scanned — ` +
        `an empty directory makes the SHA-pin rule vacuous.`,
    );
  }
  return files;
}

/** Strips one layer of matching YAML quotes, so `"a/b@sha"` parses like `a/b@sha`. */
function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/** Every `uses:` reference in one workflow file, in line order. */
function collectUsesReferences(dir: string, file: string): UsesReference[] {
  const text = readFileSync(join(dir, file), "utf8").split("\r\n").join("\n");
  const references: UsesReference[] = [];
  text.split("\n").forEach((line, index) => {
    if (COMMENT_LINE_PATTERN.test(line)) return;
    const match = USES_LINE_PATTERN.exec(line);
    if (!match) return;
    references.push({
      file,
      line: index + 1,
      value: unquote(match[1]),
      comment: match[2].trim(),
    });
  });
  return references;
}

/** Local and `docker://` references carry no git SHA — see the header. */
function isExemptReference(value: string): boolean {
  return LOCAL_REF_PATTERN.test(value) || DOCKER_REF_PATTERN.test(value);
}

/** The action's name — everything before the `@`. */
function actionName(value: string): string {
  return value.split("@")[0];
}

/**
 * One of the scanned workflow files, as text. Throws when the file is not in
 * the scan: a renamed or deleted workflow must surface as a broken guard, not
 * as a rule with nothing left to check.
 */
function readScannedWorkflow(file: string, scanned: string[]): string {
  if (!scanned.includes(file)) {
    throw new Error(
      `${file} is not among the workflows scanned in ${WORKFLOWS_DIR} ` +
        `(found: ${scanned.join(", ")}). Update this guard deliberately ` +
        `instead of letting the rule below pass over a file that is gone.`,
    );
  }
  return readFileSync(join(WORKFLOWS_DIR, file), "utf8")
    .split("\r\n")
    .join("\n");
}

/**
 * The FIRST block-scalar `if:` of a workflow — the job-level condition — with
 * its commentary stripped. Both halves matter: scoping to the block keeps the
 * commented-out `# if: |` example that sits BELOW it out of the match, and
 * dropping `#` lines keeps a commented copy of the condition from satisfying
 * the rule. The block ends at the first non-blank line indented no further
 * than the `if:` key itself.
 */
function jobLevelIfBlock(text: string, file: string): string {
  const start = BLOCK_IF_PATTERN.exec(text);
  if (!start) {
    throw new Error(
      `No block-scalar \`if:\` found in ${file}. This guard reads the job's ` +
        `condition out of that block — respell the condition there, or teach ` +
        `this helper the new shape; never leave the rule reading nothing.`,
    );
  }
  const indent = start[1].length;
  const body: string[] = [];
  for (const line of text.slice(start.index + start[0].length).split("\n")) {
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= indent) break;
    if (COMMENT_LINE_PATTERN.test(line)) continue;
    body.push(line);
  }
  return body.join("\n");
}

const WORKFLOW_FILES = listWorkflowFiles(WORKFLOWS_DIR);

const USES_REFERENCES = WORKFLOW_FILES.flatMap((file) =>
  collectUsesReferences(WORKFLOWS_DIR, file),
);

/** The references the pin rule applies to: everything that is not exempt. */
const PINNED_REFERENCES = USES_REFERENCES.filter(
  (reference) => !isExemptReference(reference.value),
);

const PINNED_ACTION_NAMES = PINNED_REFERENCES.map((reference) =>
  actionName(reference.value),
);

describe("action pins across .github/workflows", () => {
  it("scans a directory that exists and holds the known workflow files", () => {
    expect(
      existsSync(WORKFLOWS_DIR),
      `workflow directory must exist at ${WORKFLOWS_DIR}`,
    ).toBe(true);
    for (const file of EXPECTED_WORKFLOW_FILES) {
      expect(
        WORKFLOW_FILES,
        `${file} must be among the scanned workflows — a rename that drops a ` +
          `file from this scan removes it from the SHA-pin rule silently.`,
      ).toContain(file);
    }
  });

  it("parses a non-vacuous number of uses: references", () => {
    // Positive companion (test.md → "Guard tests must prove they can fail"):
    // the per-reference rule below is trivially satisfied by an empty list, so
    // a drifted USES_LINE_PATTERN would pin nothing while staying green.
    expect(
      USES_REFERENCES.length,
      `Only ${USES_REFERENCES.length} uses: references were parsed across ` +
        `${WORKFLOW_FILES.join(", ")}, below the floor of ` +
        `${EXPECTED_USES_COUNT}. Either steps were deleted (raise the floor ` +
        `deliberately) or USES_LINE_PATTERN stopped matching the spelling the ` +
        `workflows use — in which case every pin assertion below is vacuous.`,
    ).toBeGreaterThanOrEqual(EXPECTED_USES_COUNT);
    expect(
      PINNED_REFERENCES.length,
      `Every parsed reference was treated as exempt. isExemptReference() is ` +
        `too broad — the pin rule would apply to nothing.`,
    ).toBeGreaterThan(0);
  });

  it("finds the actions the pipeline is built on", () => {
    for (const action of REQUIRED_ACTIONS) {
      expect(
        PINNED_ACTION_NAMES.some(
          (name) => name === action || name.startsWith(`${action}/`),
        ),
        `${action} was not found among the parsed references ` +
          `(${[...new Set(PINNED_ACTION_NAMES)].join(", ")}). The workflows ` +
          `use it, so the scan is missing a \`uses:\` spelling and those ` +
          `references go unpinned.`,
      ).toBe(true);
    }
  });

  it("exempts local and docker:// references from the pin rule", () => {
    // The exemption is pinned in both directions so the first local action
    // added does not go red for the wrong reason, and so widening it later
    // cannot quietly excuse a real third-party action.
    expect(isExemptReference("./.github/actions/setup")).toBe(true);
    expect(isExemptReference("../shared/action")).toBe(true);
    expect(isExemptReference("docker://alpine:3.20")).toBe(true);
    expect(isExemptReference("actions/checkout@v5")).toBe(false);
    expect(isExemptReference(`actions/checkout@${"0".repeat(40)}`)).toBe(false);
  });

  // Driven off the references actually parsed out of the directory, not a
  // hard-coded list: a new step — in any workflow file, including one added
  // later — inherits the rule automatically, and the two companions above are
  // what stop that list from silently shrinking to nothing.
  it.each(PINNED_REFERENCES)(
    "pins $file:$line ($value) to a commit SHA with a version comment",
    ({ file, line, value, comment }: UsesReference) => {
      expect(
        PINNED_REF_PATTERN.test(value),
        `${file}:${line} uses \`${value}\`, which is not pinned to a full ` +
          `40-character lowercase commit SHA. A tag or branch ref is mutable: ` +
          `the action's owner can change what this pipeline executes without ` +
          `a commit here. Resolve the tag to its SHA and keep the tag as the ` +
          `trailing comment — \`uses: owner/repo@<40 hex> # v1.2.3\`.`,
      ).toBe(true);
      expect(
        comment,
        `${file}:${line} pins \`${value}\` but carries no version comment. ` +
          `A bare SHA is unreadable, so nobody can tell an upgrade from a ` +
          `downgrade at review time and the pin rots in place. Append the tag ` +
          `the SHA was resolved from — \`# v1.2.3\`.`,
      ).toMatch(VERSION_COMMENT_PATTERN);
    },
  );
});

describe("dependabot and the review workflow", () => {
  it("keeps Dependabot pull requests out of the Claude review job", () => {
    // Positive companion first (test.md → "Guard tests must prove they can
    // fail"): the rule below only matters while Dependabot actually opens
    // github-actions PRs. Drop the config — or switch its ecosystem — and the
    // condition is dead code that nobody would notice rotting.
    expect(
      existsSync(DEPENDABOT_CONFIG),
      `No dependabot.yml at ${DEPENDABOT_CONFIG}. The SHA pins above are ` +
        `frozen by design and Dependabot is what bumps them — without it they ` +
        `silently age instead of being reviewed weekly.`,
    ).toBe(true);
    expect(
      readFileSync(DEPENDABOT_CONFIG, "utf8"),
      `dependabot.yml does not configure the github-actions ecosystem, so ` +
        `nothing bumps the pinned SHAs and the author condition below guards ` +
        `a pull request that never arrives.`,
    ).toContain(GITHUB_ACTIONS_ECOSYSTEM);

    const workflow = readScannedWorkflow(REVIEW_WORKFLOW_FILE, WORKFLOW_FILES);
    expect(
      jobLevelIfBlock(workflow, REVIEW_WORKFLOW_FILE),
      `${REVIEW_WORKFLOW_FILE}'s job-level \`if:\` does not exclude ` +
        `dependabot[bot], so every weekly Dependabot pull request triggers a ` +
        `review that cannot run: GitHub gives a bot-authored pull_request ` +
        `event no Actions secrets and a read-only token, so the job dies ` +
        `before the model call and leaves a red X on the very PRs that keep ` +
        `the action pins current. Add ` +
        `\`github.event.pull_request.user.login != 'dependabot[bot]'\` to ` +
        `that condition — a comment saying so does not count.`,
    ).toMatch(DEPENDABOT_SKIP_PATTERN);
  });
});
