import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Browser-only globals. tsconfig.json includes the DOM lib (its consumers in
// extension/ and pwa/ do, and `URLSearchParams` in src/config/links.ts needs a
// lib entry), but shared/ is ALSO imported by Node-side scripts run under tsx
// (extension/scripts/verify-build.ts, verify-selectors.ts). DOM lib therefore
// buys no protection there: `document.querySelector` would typecheck fine and
// blow up at runtime. Restrict the globals themselves so that guarantee is
// static rather than a convention.
const BROWSER_ONLY_GLOBALS = [
  "document",
  "window",
  "localStorage",
  "sessionStorage",
  "navigator",
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        // Only one project here: shared/ is pure TypeScript library code with
        // no Node-side scripts and no test directory of its own (its consumers
        // in extension/ and pwa/ own the tests that cover it).
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": [
        "error",
        ...BROWSER_ONLY_GLOBALS.map((name) => ({
          name,
          message:
            "shared/ must stay runtime-agnostic: it is imported by browser code (extension/, pwa/) AND by Node scripts run under tsx. Take the value as a parameter from the caller instead.",
        })),
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.js", "*.config.ts"],
  },
);
