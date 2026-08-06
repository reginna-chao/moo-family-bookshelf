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
        // Node-side asset-generation scripts are type-aware-lintable too;
        // without it every file under scripts/ fails to parse.
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
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // Test files opt out of production-hygiene rules, not of correctness rules.
  // The single relaxation is `no-non-null-assertion`: `!` right after an
  // explicit truthiness assertion is idiomatic test style. Everything else
  // (unused vars, irregular whitespace, no-explicit-any, ...) stays enforced in
  // tests exactly as it is in src/.
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.js", "*.config.ts"],
  },
);
