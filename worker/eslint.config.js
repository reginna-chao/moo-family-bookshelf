import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Layering guardrail (see .claude/rules/backend.md, "Layering"): a route
  // module must never import business or security logic from a SIBLING route
  // module — logic shared by two or more routes belongs in src/services/.
  // Enforcing it here means a new sibling import fails CI instead of relying on
  // a reviewer noticing it. Note the patterns use gitignore semantics (ESLint
  // feeds the group to the `ignore` package): a single `*` never crosses `/`,
  // but a pattern that matches a directory also covers everything beneath it,
  // so `./*` matches `./sub` and thereby a future nested `./sub/module` too
  // (verified against the real rule, ESLint 9.39: `./sub/deep/module` is
  // flagged); `**/routes/*` closes the same door reached from any nesting depth
  // (`../routes/x`, `../../routes/x`, ...). Imports of ../utils, ../kv,
  // ../middleware, ../services, ... and bare package specifiers are unaffected.
  // `reportUnusedDisableDirectives` is raised to "error" for this scope so a
  // stale exemption fails lint: if an exempted import is later removed but its
  // eslint-disable comment is left behind, CI goes red instead of emitting a
  // warning the lint script (no --max-warnings 0) would silently pass.
  {
    files: ["src/routes/**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./*", "**/routes/*"],
              message:
                "Route modules must not import sibling route modules — shared logic belongs in src/services/ (see .claude/rules/backend.md, Layering).",
            },
          ],
        },
      ],
    },
  },
  // Test files opt out of production-hygiene rules, not of correctness rules.
  // `!` right after an explicit truthiness assertion is idiomatic test style;
  // everything else (unused vars, irregular whitespace, no-explicit-any, ...)
  // stays enforced in tests exactly as it is in src/. `_`-prefixed args are the
  // only unused-vars escape, for positionally-required params such as the
  // description column of an `it.each` tuple table.
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.js", "*.config.ts"],
  },
);
