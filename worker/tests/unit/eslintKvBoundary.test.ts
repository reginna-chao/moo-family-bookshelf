/**
 * `worker/eslint.config.js` — the `src/routes/**` KV guardrail, exercised
 * through ESLint's own Node API (#163 Wave 3).
 *
 * WHY A TEST LINTS SNIPPETS. The guardrail is five rule entries — four
 * `no-restricted-syntax` AST selectors plus the `no-restricted-imports`
 * `kvKeys` pattern group — and nothing else in the repo can tell whether they
 * still MATCH. `pnpm lint`
 * passing proves only that today's clean source is clean; a selector broken by
 * a typo (`object.property.name` → `property.name`), or narrowed while
 * refactoring the config, would keep every check green while silently
 * reopening the door. `kvAccessBoundary.test.ts` greps the source and would
 * catch a violation that actually lands; this file catches the guard going
 * blind BEFORE one does.
 *
 * The fixtures ARE the mutation evidence required by `.claude/rules/test.md`:
 * each snippet is a violation that must be reported, and the negatives are
 * legal forms that must not be. Nothing is written to disk — `lintText` is
 * given a VIRTUAL `filePath` under `src/routes/` (and `src/services/`) purely
 * so ESLint picks the matching config override.
 *
 * HOW IT IS INVOKED. ESLint's flat-config Node API (`new ESLint({ cwd,
 * overrideConfigFile })` + `lintText`), NOT a spawned CLI: the worker suite
 * runs on the default vitest node pool (see `vitest.config.ts` — no
 * `@cloudflare/vitest-pool-workers` project is configured), so node APIs are
 * available and a child process would only add startup cost and output
 * parsing.
 *
 * ONE CONFIG OVERRIDE IS NEEDED. The repo config sets
 * `parserOptions.project: ["./tsconfig.json"]`, and typescript-eslint throws
 * when asked to lint a path the TS program does not contain — which a virtual
 * fixture never is. `project: false` is layered on top, disabling type-aware
 * parsing only. It cannot mask the guardrail: none of the five rule entries is
 * type-aware (they are pure AST / specifier matches), and the override is
 * appended as its own config object, so the `files: ["src/routes/**\/*.ts"]`
 * block and its rules apply exactly as they do in CI.
 *
 * THE CONFIG PATH IS OVERRIDABLE (`MOO_ESLINT_CONFIG_FILE`), exactly like the
 * scan-root knobs in `kvAccessBoundary.test.ts` and for the same reason: the
 * mutation check `.claude/rules/test.md` requires is run by pointing this file
 * at a throwaway COPY of `eslint.config.js` with one selector removed, so the
 * real config is never edited. CI sets the variable to nothing; `cwd` stays
 * the worker root either way, so a copy is matched against the same
 * `src/routes/**` base path — and a stray value cannot make the file pass
 * vacuously, because every positive case asserts a message was reported.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { ESLint, type Linter } from "eslint";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const CONFIG_FILE =
  process.env.MOO_ESLINT_CONFIG_FILE ?? join(WORKER_ROOT, "eslint.config.js");

/**
 * Virtual paths — never created; they only select a config override. The
 * nested one models a future `src/routes/sub/` module, whose `../../kv/schema`
 * specifier is why the `kvKeys` ban is a `patterns` group and not a `paths`
 * name.
 */
const ROUTE_FIXTURE_PATH = join(WORKER_ROOT, "src/routes/__fixture__.ts");
const NESTED_ROUTE_FIXTURE_PATH = join(
  WORKER_ROOT,
  "src/routes/sub/__fixture__.ts",
);
const SERVICE_FIXTURE_PATH = join(WORKER_ROOT, "src/services/__fixture__.ts");

/**
 * The two rules this file is about. Every other message (unused vars, parser
 * noise, ...) is filtered out, so a fixture does not have to be otherwise
 * idiomatic to make its point.
 */
const GUARDRAIL_RULES = ["no-restricted-syntax", "no-restricted-imports"];

const eslint = new ESLint({
  cwd: WORKER_ROOT,
  overrideConfigFile: CONFIG_FILE,
  overrideConfig: {
    languageOptions: {
      parserOptions: { project: false, projectService: false },
    },
  },
});

interface LintCase {
  label: string;
  /** Which virtual module the snippet pretends to be. */
  filePath: string;
  code: string;
  /** Rule that must report it, or `null` when the form is legal. */
  expectedRule: string | null;
  /**
   * Substring of the message that must appear. Both guardrail rules carry
   * several configurations, so the ruleId alone cannot say WHICH entry fired.
   */
  expectedMessage?: string;
}

/** Snippets share this preamble so each one is a parseable ES module. */
const PREAMBLE = `declare const c: { env: { KV: unknown } };\nexport const id = "abcd-1234";\n`;

const CASES: LintCase[] = [
  {
    label: "c.env.KV.get(...)",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => c.env.KV.get("user:1");`,
    expectedRule: "no-restricted-syntax",
  },
  {
    label: "c.env.KV.put(...)",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => c.env.KV.put("user:1", "{}");`,
    expectedRule: "no-restricted-syntax",
  },
  {
    label: "c.env.KV.delete(...)",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => c.env.KV.delete("user:1");`,
    expectedRule: "no-restricted-syntax",
  },
  {
    label: "const kv = c.env.KV",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => { const kv = c.env.KV; return kv; };`,
    expectedRule: "no-restricted-syntax",
  },
  {
    // The same alias reached by ASSIGNMENT rather than declaration: the
    // declarator selector inspects `init`, so it is blind to this form and a
    // fourth selector on `AssignmentExpression` carries it.
    label: "let kv; kv = c.env.KV",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => { let kv; kv = c.env.KV; return kv; };`,
    expectedRule: "no-restricted-syntax",
    expectedMessage: "Route modules must not alias the KV binding",
  },
  {
    label: "const { KV } = c.env",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => { const { KV } = c.env; return KV; };`,
    expectedRule: "no-restricted-syntax",
  },
  {
    label: 'import { kvKeys } from "../kv/schema"',
    filePath: ROUTE_FIXTURE_PATH,
    code: `import { kvKeys } from "../kv/schema";\nexport const key = kvKeys.user("1");`,
    expectedRule: "no-restricted-imports",
  },
  {
    // Reached from a nested route dir, where the specifier gains a `../`. A
    // `paths: { "../kv/schema": ... }` entry — the ban's original shape — is
    // an exact specifier match and would miss this one entirely.
    label: 'import { kvKeys } from "../../kv/schema" (nested route dir)',
    filePath: NESTED_ROUTE_FIXTURE_PATH,
    code: `import { kvKeys } from "../../kv/schema";\nexport const key = kvKeys.user("1");`,
    expectedRule: "no-restricted-imports",
    expectedMessage: "Routes never build KV keys",
  },
  {
    // The SANCTIONED form: the binding travels as an argument, so the callee's
    // object is not `X.KV` and the selector must stay silent.
    label: "getFamilyRecord(c.env.KV, id) — argument position",
    filePath: ROUTE_FIXTURE_PATH,
    code: `${PREAMBLE}declare function getFamilyRecord(kv: unknown, id: string): Promise<unknown>;\nexport const run = () => getFamilyRecord(c.env.KV, id);`,
    expectedRule: null,
  },
  {
    // Only `kvKeys` is banned from ../kv/schema — types, BoolFlag and the TTL
    // constants stay available to routes.
    label: 'import { BoolFlag } from "../kv/schema"',
    filePath: ROUTE_FIXTURE_PATH,
    code: `import { BoolFlag } from "../kv/schema";\nexport const flag = BoolFlag.TRUE;`,
    expectedRule: null,
  },
  {
    // Widening the `kvKeys` ban to a `**/kv/schema` pattern must not have
    // swept in the module's other exports at depth — and the sibling-route
    // group must stay silent too: `../../kv/schema` matches neither `./*` nor
    // `**/routes/*`.
    label: 'import { BoolFlag } from "../../kv/schema" (nested route dir)',
    filePath: NESTED_ROUTE_FIXTURE_PATH,
    code: `import { BoolFlag } from "../../kv/schema";\nexport const flag = BoolFlag.TRUE;`,
    expectedRule: null,
  },
  {
    // Same snippet, different layer: `services/` may touch KV directly (the
    // override is routes-scoped), so this must NOT be reported.
    label: "c.env.KV.get(...) under src/services/",
    filePath: SERVICE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => c.env.KV.get("user:1");`,
    expectedRule: null,
  },
  {
    // Ditto for the assignment alias: the fourth selector is routes-scoped, so
    // a services module aliasing the binding stays legal.
    label: "let kv; kv = c.env.KV under src/services/",
    filePath: SERVICE_FIXTURE_PATH,
    code: `${PREAMBLE}export const run = () => { let kv; kv = c.env.KV; return kv; };`,
    expectedRule: null,
  },
];

/** Guardrail messages only, keyed by case label. */
const reported = new Map<string, Linter.LintMessage[]>();

beforeAll(async () => {
  for (const testCase of CASES) {
    const [result] = await eslint.lintText(testCase.code, {
      filePath: testCase.filePath,
    });
    reported.set(
      testCase.label,
      result.messages.filter(
        (message) =>
          message.ruleId !== null && GUARDRAIL_RULES.includes(message.ruleId),
      ),
    );
  }
}, 120_000);

const VIOLATIONS = CASES.filter((testCase) => testCase.expectedRule !== null);
const LEGAL = CASES.filter((testCase) => testCase.expectedRule === null);

describe("eslint.config.js — src/routes/** KV guardrail", () => {
  it.each(VIOLATIONS)(
    "reports $label via $expectedRule",
    ({ label, expectedRule, expectedMessage }) => {
      const messages = reported.get(label) ?? [];
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.map((message) => message.ruleId)).toContain(expectedRule);
      if (expectedMessage !== undefined) {
        expect(messages.map((message) => message.message).join("\n")).toContain(
          expectedMessage,
        );
      }
    },
  );

  it("explains the kvKeys ban with the KV-key message, not the sibling-import one", () => {
    // `no-restricted-imports` carries two `patterns` groups in this override
    // (the sibling-route one, and this `**/kv/schema` group narrowed to the
    // `kvKeys` importName); pinning the text proves the KV one fired.
    const messages =
      reported.get('import { kvKeys } from "../kv/schema"') ?? [];
    expect(messages.map((message) => message.message).join("\n")).toContain(
      "Routes never build KV keys",
    );
  });

  it.each(LEGAL)("does not report $label", ({ label }) => {
    expect(reported.get(label) ?? []).toEqual([]);
  });
});
