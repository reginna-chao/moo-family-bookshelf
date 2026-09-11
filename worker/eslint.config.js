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
  //
  // Second guardrail, same scope (see .claude/rules/backend.md, "Layering"):
  // a route module must never touch the KV binding itself. All KV access goes
  // through src/kv/* (data access, one module per key family) or src/services/*
  // (logic shared by two or more routes), so key spelling, value encoding and
  // TTLs live in one place per key and a handler cannot invent a key or forget
  // a TTL.
  //
  // BLOCKED (the four `no-restricted-syntax` selectors below):
  //   (a) any method call ON the binding — `c.env.KV.get(...)`, `.put`,
  //       `.delete`, `.list`; the selector keys on the CALLEE's object being
  //       `X.KV`, which is why it does not fire on an argument;
  //   (b) aliasing it at declaration — `const kv = c.env.KV;`
  //   (c) aliasing it by assignment — `let kv; kv = c.env.KV;`
  //   (d) destructuring it out of env — `const { KV } = c.env;`
  // Plus `no-restricted-imports` → `patterns`: importing `kvKeys` from any
  // `**/kv/schema` specifier — `../kv/schema` from `src/routes/`, and
  // `../../kv/schema` from a future nested `src/routes/sub/`. Other
  // `../kv/schema` exports (types, BoolFlag, TTL constants) stay available.
  //
  // ALLOWED: passing the binding as an ARGUMENT —
  // `readBorrowIndex(c.env.KV, id)`, `getFamilyRecord(c.env.KV, id)`,
  // `validateVerification(c.env, ...)` — which is exactly how routes reach
  // src/kv/* and src/services/*.
  //
  // DIVISION OF LABOUR, so this config is not read as more than it is. ESLint
  // covers the STATIC forms listed above and nothing else. In particular it
  // does NOT close the file-local-helper shape — `async function readX(kv:
  // KVNamespace) { kv.get(...) }`, where the binding arrives as a parameter:
  // the selectors key on the callee's object, and the `kvKeys` ban misses it
  // too, because such a helper can hand-write its key
  // (`kv.put("family:" + id, ...)`) and import nothing at all. What pins that
  // form is the grep tripwire `worker/tests/unit/kvAccessBoundary.test.ts`,
  // which reads the route sources and asserts zero `kv.get|put|delete|list(`
  // calls, zero `c.env.KV.`, zero `kvKeys` imports, plus the single-importer
  // rule for `putPublicShelves`. That last rule also pins the OTHER
  // ESLint-blind shape: a WILDCARD binding of the public-shelf DAL — `import
  // * as dal from "../kv/publicShelves"`, and the re-export spellings
  // `export * from` / `export * as x from` — counts as an import of the put
  // whether or not `.putPublicShelves` is ever written out, and the grep goes
  // red for any module under `src/` other than `routes/publicShelf.ts`.
  // ESLint does not see that form: no selector fires (the binding reaches the
  // accessor as an ARGUMENT) and no `no-restricted-imports` entry names that
  // module. The `kvKeys` ban is NOT escaped this way, though —
  // `no-restricted-imports` reports a `*` import when `importNames` is set, so
  // `import * as schema from "../kv/schema"` is still flagged. Complementing
  // the grep from the other side, `worker/tests/unit/eslintKvBoundary.test.ts`
  // lints fixtures through ESLint's Node API, so a selector that stops
  // MATCHING (a typo, a narrowing refactor) fails CI instead of going quietly
  // blind.
  //
  // KNOWN BOUNDARY — no check in the repo makes any of these red:
  //   - computed binding access: `c.env["KV"].get(...)`, `Reflect.get(c.env,
  //     "KV")`;
  //   - a DYNAMIC `import()` — of a key builder, or of a src/kv/* module
  //     (`const dal = await import("../kv/publicShelves")`, which hands a
  //     module the very put its static wildcard twin is caught for). The core
  //     `no-restricted-imports` rule does not inspect dynamic imports, and
  //     both grep detectors key on a static `... from "<specifier>"` clause,
  //     which such a call does not have;
  //   - a file-local helper whose `KVNamespace` parameter is not named `kv`
  //     (e.g. `store.get(...)`) — outside every selector AND outside the grep
  //     tripwire's `kv.<op>(` pattern.
  // These are limits of the rule implementations, not accepted usage — the
  // layering rule applies to those forms too.
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
            {
              // A `patterns` group, not a `paths` name: it must also catch
              // `../../kv/schema` from a future nested `src/routes/sub/x.ts`.
              group: ["**/kv/schema"],
              importNames: ["kvKeys"],
              message:
                "Routes never build KV keys — use src/kv/* accessors (see .claude/rules/backend.md, Layering).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression > MemberExpression[object.type='MemberExpression'][object.property.name='KV']",
          message:
            "Route modules must not call the KV binding directly — use src/kv/* accessors, or a src/services/* helper, and pass c.env.KV as an argument (see .claude/rules/backend.md, Layering).",
        },
        {
          selector:
            "VariableDeclarator[init.type='MemberExpression'][init.property.name='KV']",
          message:
            "Route modules must not alias the KV binding — pass c.env.KV to a src/kv/* accessor instead (see .claude/rules/backend.md, Layering).",
        },
        {
          // Same alias, reached by assignment rather than declaration
          // (`let kv; kv = c.env.KV;`), which the declarator selector misses.
          selector:
            "AssignmentExpression[right.type='MemberExpression'][right.property.name='KV']",
          message:
            "Route modules must not alias the KV binding — pass c.env.KV to a src/kv/* accessor instead (see .claude/rules/backend.md, Layering).",
        },
        {
          selector: "ObjectPattern > Property[key.name='KV']",
          message:
            "Route modules must not destructure the KV binding — pass c.env.KV to a src/kv/* accessor instead (see .claude/rules/backend.md, Layering).",
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
