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
