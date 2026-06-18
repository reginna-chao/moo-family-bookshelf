---
name: bump-ver
description: >
  Bump the project version across all 5 version files (extension, pwa, worker, root package.json,
  extension manifest), append a CHANGELOG entry generated from commits since the last tag, and
  generate the bilingual GitHub Release notes file the CD workflow reads at tag time.
  Skips the Fix Cycle — pure release prep, no production code changes.
  TRIGGER when: user explicitly invokes /bump-ver, or asks to bump version / cut a release / update CHANGELOG for a version.
  DO NOT TRIGGER when: user wants to write code, fix bugs, or run tests. Code changes go through team-lead, not here.
argument-hint: "<x.y.z | patch | minor | major>"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log*), Bash(git tag*), Bash(git describe*), Bash(git status*), Bash(git diff*), Bash(git add*), Bash(git commit*), Bash(pnpm typecheck*)
model: opus
---

# Bump Version

## Role

Cut a release: bump version numbers across all packages, draft CHANGELOG entry from commits, run typecheck, commit. **One confirmation gate** — no per-phase checkpoints.

## Why this exists

Pure version bumps don't need the team-lead Fix Cycle. This skill encodes the project's release conventions so the user doesn't re-answer the same questions every release.

## Encoded conventions (do not re-ask)

- **All 5 version files synced** to the same target: `extension/package.json`, `extension/public/manifest.json`, `pwa/package.json`, `worker/package.json`, root `package.json`.
- **CHANGELOG language**: 繁體中文（台灣）, follows existing structure. Heading: `## vX.Y.Z（YYYY-MM-DD）`. Group bullets under sub-section headings (e.g. `### 問題修正`, `### 功能新增`, `### 安全與穩定性`) — match how prior entries are organized.
- **Excluded from CHANGELOG** (internal, not user-facing): `chore:`, `docs:`, `test:`, `refactor:`, `ci:`, `build:`, `style(<dev-tooling>):`. Internal tooling commits (e.g. `chore(skills): ...`) are always excluded.
- **Included in CHANGELOG** (user-facing): `feat:`, `fix:`, `perf:`, `security:`. `style(<user-facing>):` (e.g. `style(extension)`, `style(pwa)`) is included as a UI tweak.
- **Bilingual Release notes file**: every bump also creates `docs/release-notes/v<X.Y.Z>.md` (filename carries the `v` prefix to match the git tag the CD workflow reads via `github.ref_name`). It follows `docs/release-notes/TEMPLATE.md`'s bilingual structure: English section first (public Release faces international readers — intentional, do not flip), 繁體中文 section second. The 繁中 section reuses the CHANGELOG bullets just drafted; the English section is a curated, natural translation (not literal). Drop unused categories. This file must exist in the commit the tag points to, so it is created here, before the user tags.
- **No git tag**: the user tags manually after this skill finishes. Never run `git tag`.
- **Worker version stays in sync**: even though Worker historically lagged at 1.0.0, going forward it bumps with everything else.
- **Source-code `// vX.Y.Z` markers are NOT version numbers** — they tag when a feature was introduced and must NOT be touched.

## Invocation

```
/bump-ver 1.2.1            # explicit version
/bump-ver patch            # auto-bump patch (1.2.0 → 1.2.1)
/bump-ver minor            # auto-bump minor (1.2.0 → 1.3.0)
/bump-ver major            # auto-bump major (1.2.0 → 2.0.0)
/bump-ver                  # no arg → ask user for target version
```

## Workflow

### Step 1 — Read state

1. Current version from `extension/package.json` (canonical source).
2. Last tag: `git describe --tags --abbrev=0`.
3. Commits since last tag: `git log --oneline <last-tag>..HEAD`.
4. Read existing `CHANGELOG.md` to match heading and sub-section style.
5. Resolve target version from arg:
   - explicit `x.y.z` → use as-is, validate it is greater than current
   - `patch` / `minor` / `major` → compute from current
   - missing → ask user (single sentence)

### Step 2 — Classify commits

For each commit since last tag:

- **Include** if prefix matches: `feat:`, `fix:`, `perf:`, `security:`, or `style:` with a user-facing scope like `(extension)`, `(pwa)`, `(dialog)`, `(ui)`.
- **Exclude** if prefix matches: `chore:`, `docs:`, `test:`, `refactor:`, `ci:`, `build:`, or `style:` with a dev-tooling scope like `(skills)`, `(eslint)`, `(scripts)`.
- For ambiguous commits, default to **exclude** and surface them in the plan as "uncertain — confirm if these should be in CHANGELOG".

### Step 3 — Draft CHANGELOG entry

Generate a draft following the project's existing structure:

```markdown
## vX.Y.Z（YYYY-MM-DD）

### <sub-section heading in 繁體中文>

- <bullet rewritten in 繁體中文, focused on user impact, not commit subject line>
```

Sub-section heading rules (pick the headings that fit the included commits):

- `### 功能新增` for `feat:`
- `### 問題修正` for `fix:`
- `### 效能改善` for `perf:`
- `### 安全與穩定性` for `security:` and stability-flavored fixes
- `### 介面調整` for user-facing `style:`
- If only one category exists, the heading still goes in (matches existing entries).

Bullet style: short, action-oriented sentence describing **what the user notices**, not the technical change. Use existing CHANGELOG bullets as reference for tone and granularity.

### Step 3b — Draft the bilingual Release notes file

Generate the content for `docs/release-notes/v<X.Y.Z>.md` from the SAME included commits, following `docs/release-notes/TEMPLATE.md`:

- **Order**: `# English` section first, then `# 繁體中文` section, separated by `---`. Do not flip (see encoded conventions).
- **繁體中文 section**: reuse the CHANGELOG bullets drafted in Step 3 verbatim (same wording, same categories) — the two must stay in sync.
- **English section**: a curated, natural translation of the same bullets — not a literal word-for-word rendering; adjust phrasing to read as native English.
- **Categories**: use the four TEMPLATE pairs (New Features / 功能新增, Improvements / 改善調整, Bug Fixes / 問題修正, Developer Experience / 開發者體驗). Map `perf:` and user-facing `style:` into Improvements; fold `security:`/stability items into Improvements unless there are enough to warrant calling them out. **Delete any category with no items** — never leave an empty heading.
- Do NOT add the `<details>` commit list or the Full Changelog link — the CD workflow appends those automatically at release time.
- Do NOT include the HTML `<!-- ... -->` instructions from TEMPLATE.md; those are authoring guidance, not release content.

### Step 4 — Present plan and wait for confirmation (only confirmation gate)

Show the user:

1. **Target version**: `<current> → <target>`
2. **Files to bump**: the 5 version files (always the same list)
3. **Commits included** (table): hash, subject, "in CHANGELOG"
4. **Commits excluded** (table): hash, subject, reason
5. **Draft CHANGELOG entry**: rendered as it will appear in the file
6. **Draft Release notes file** (`docs/release-notes/v<X.Y.Z>.md`): rendered bilingual content, so the user can tweak the English curation before commit
7. **Open questions** ONLY if genuinely ambiguous (e.g. unclassifiable commit, version conflict). Otherwise no questions — convention is encoded.

End with: "確認後我直接套用變更、跑 typecheck、commit。"

### Step 5 — Execute (after user approval)

In order:

1. `Edit` each of the 5 version files. Use `replace_all: false` and a precise `old_string` that includes the `"name": "..."` line above the version, so we never match a dependency version by accident.
2. `Edit` `CHANGELOG.md`: insert the new entry directly above the most recent entry (between `---` separator and `## v<previous>`).
3. `Write` `docs/release-notes/v<X.Y.Z>.md` with the bilingual content from Step 3b (no `<details>`/Full Changelog, no template comment).
4. Run `pnpm typecheck` from repo root. If it fails, stop and report.
5. `git add` only the 7 changed files (5 version files + `CHANGELOG.md` + `docs/release-notes/v<X.Y.Z>.md`). Never `git add -A`.
6. `git commit` with this message:

   ```
   chore(release): bump version to <X.Y.Z>

   - Sync extension, pwa, worker, root package.json and extension manifest to <X.Y.Z>
   - Add CHANGELOG entry for v<X.Y.Z> (<2-4 word summary of each included commit, comma-separated>)
   - Add bilingual GitHub Release notes (docs/release-notes/v<X.Y.Z>.md)
   ```

7. Report the new commit hash and remind: **tag is the user's job** (do not auto-tag).

## Edge cases

- **No commits since last tag**: stop. Tell user there is nothing to release.
- **Only excluded commits since last tag** (all `chore`/`docs`): warn that there's nothing user-facing, ask whether to proceed (e.g. release purely for tooling reasons).
- **Target version equals current**: stop with an error.
- **Target version is lower than current**: stop with an error.
- **Working tree is dirty before starting**: stop and ask the user to commit or stash first — never bundle unrelated changes into a release commit.
- **Last tag does not exist** (fresh repo): use the initial commit as the diff base.
- **Source-code `// vX.Y.Z` markers**: never modify these. They are feature-introduction markers, not the current version. The 5 listed files are the only files this skill touches (plus `CHANGELOG.md` and `docs/release-notes/v<X.Y.Z>.md`).

## Do NOT

- Run `git tag` — ever. The user tags manually.
- Modify any file outside the 7 listed (5 version files + CHANGELOG.md + docs/release-notes/v<X.Y.Z>.md).
- Touch source-code `// vX.Y.Z` comments or doc references like `(v1.2.0)` in `docs/`, `.claude/rules/`, or `.test.ts` files.
- Run the full Fix Cycle (coder/tester/review) — this skill is explicitly for changes that don't need it.
- Push to remote.
- Re-ask any question already answered by the encoded conventions above.
