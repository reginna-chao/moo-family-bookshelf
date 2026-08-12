import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.scripts.json is listed alongside the app project so the
        // Node-side build/verify scripts are type-aware-lintable too; without
        // it every file under scripts/ fails to parse.
        project: ["./tsconfig.json", "./tsconfig.scripts.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Severity is written here rather than left to the CLI's --max-warnings 0,
      // so IDEs render it red exactly as the CI gate treats it.
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Test files opt out of production-hygiene rules, NOT of correctness rules.
  // Rules that catch real defects (no-unused-vars, no-empty, no-explicit-any,
  // ...) stay enforced here exactly as they are for src/.
  {
    files: ["tests/**"],
    rules: {
      // `foo!` right after an explicit `expect(foo).toBeTruthy()` is standard
      // test style: the assertion already guarantees non-null.
      "@typescript-eslint/no-non-null-assertion": "off",
      // `void` shows up in mock callback signatures and generic arguments when
      // mirroring the real API's return type; not a production type-modelling smell.
      "@typescript-eslint/no-invalid-void-type": "off",
      // In-memory storage mocks emulate `storage.remove`/`clear`, which delete
      // caller-supplied keys from a plain record — dynamic by definition.
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  // Playwright's fixture API passes a callback conventionally named `use`, which
  // eslint-plugin-react-hooks mistakes for React's `use` hook. Scoped to the E2E
  // directory (which contains no React code at all) so genuine hook-rule
  // violations in component tests still fail the build.
  {
    files: ["tests/e2e/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.js", "*.config.ts"],
  },
);
