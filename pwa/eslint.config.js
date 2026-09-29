import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Production files (src/) are capped at MAX_LINES raw lines — blank lines and
// comments count, so the number matches `wc -l` (issue #210). The files below
// already exceeded the cap when it was introduced; each is pinned to its line
// count at that time, so it may shrink but never grow. Maintenance: when a
// listed file shrinks, lower its number in the same change; once it is at or
// under MAX_LINES, delete its entry. Never raise a number and never add an
// entry — split the file instead. Keys are relative to this directory.
const MAX_LINES = 200;
const MAX_LINES_LEGACY_CEILINGS = {
  "src/App.tsx": 415,
  "src/api/client.ts": 706,
  "src/components/MemberList.tsx": 300,
  "src/components/PatternLock.tsx": 285,
  "src/components/PublicShareDialog.tsx": 324,
  "src/components/VerifySetupPrompt.tsx": 269,
  "src/hooks/useAuth.ts": 326,
  "src/hooks/useFamilyData.tsx": 445,
  "src/hooks/usePublicShelfActions.ts": 286,
  "src/pages/BorrowPage.tsx": 259,
  "src/pages/FamilyShelfPage.tsx": 224,
  "src/pages/LandingPage.tsx": 581,
  "src/pages/PersonalShelfPage.tsx": 540,
  "src/pages/PublicShelfPage.tsx": 202,
  "src/pages/SettingsPage.tsx": 631,
};

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
      // Severity is written here rather than left to the CLI's --max-warnings 0,
      // so IDEs render it red exactly as the CI gate treats it.
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
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
