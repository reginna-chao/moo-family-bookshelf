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
  "src/api/auth-refresh.ts": 425,
  "src/api/client.ts": 866,
  "src/background/messageHandlers.ts": 301,
  "src/content/index.ts": 584,
  "src/content/mobileLayout.ts": 292,
  "src/content/readmoo-lend.ts": 423,
  "src/dialog/App.tsx": 484,
  "src/dialog/BorrowTab.tsx": 475,
  "src/dialog/FamilyShelf.tsx": 215,
  "src/dialog/MemberList.tsx": 402,
  "src/dialog/Onboarding.tsx": 281,
  "src/dialog/OverflowMenu.tsx": 214,
  "src/dialog/PatternLock.tsx": 255,
  "src/dialog/PersonalShelf.tsx": 403,
  "src/dialog/PublicShareDialog.tsx": 418,
  "src/dialog/VerificationPrompt.tsx": 211,
  "src/dialog/VerificationSettings.tsx": 304,
  "src/dialog/onboardingFlow.ts": 450,
  "src/dialog/useAutoSetup.ts": 217,
  "src/dialog/useEndpointSwitch.ts": 234,
  "src/dialog/usePersonalBooks.ts": 248,
  "src/dialog/usePublicShelfActions.ts": 286,
  "src/dialog/useReauth.ts": 205,
  "src/dialog/useVerificationPrompt.ts": 345,
  "src/sync/syncBooks.ts": 243,
};

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
