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

// Production files (src/) are capped at MAX_LINES raw lines — blank lines and
// comments count, so the number matches `wc -l` (issue #210). The files below
// already exceeded the cap when it was introduced; each is pinned to its line
// count at that time, so it may shrink but never grow. Maintenance: when a
// listed file shrinks, lower its number in the same change; once it is at or
// under MAX_LINES, delete its entry. Never raise a number and never add an
// entry — split the file instead. Keys are relative to this directory.
const MAX_LINES = 200;
const MAX_LINES_LEGACY_CEILINGS = {
  "src/api/bookshelfValidation.ts": 233,
  "src/api/entityText.ts": 280,
  "src/api/types.ts": 292,
  "src/config/readmoo.ts": 412,
};

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
  // Later flat-config blocks win for a file they match, so each legacy
  // ceiling below overrides the base cap for that one file only.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: MAX_LINES }] },
  },
  ...Object.entries(MAX_LINES_LEGACY_CEILINGS).map(([file, max]) => ({
    files: [file],
    rules: { "max-lines": ["error", { max }] },
  })),
  {
    ignores: ["dist/", "node_modules/", "*.config.js", "*.config.ts"],
  },
);
