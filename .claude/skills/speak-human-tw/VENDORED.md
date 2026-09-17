# Vendored: speak-human-tw

- Upstream: https://github.com/Raymondhou0917/speak-human-tw
- Author: Raymond Hou — MIT License (see `LICENSE`, kept verbatim)
- Version: 1.4.0 (`SKILL.md` frontmatter), upstream commit `7df8e6fc271436e09971a39141e86806fc1f3afd`
- Vendored on: 2026-09-16

## What is included

`SKILL.md`, `LICENSE`, and `references/` (`patterns.md`, `taiwan-localization.md`, `humanize.md`,
`protected-list.md`, `scenes.md`, `examples.md`) — copied byte-for-byte from upstream. Omitted:
`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `assets/`, `evals/`, `install/`, `scripts/`,
`.github/` — they document or test the upstream project and are not needed to run the skill.

## Why it lives in the repo instead of `~/.claude/skills/`

The `coder` agent and `/bump-ver` read rules with `Read`; a skill installed only on one developer's
machine is invisible to them and to every other clone. Keeping it here makes the de-AI pass part of
the repository's process (`.claude/rules/user-facing-copy.md` → Rule 9), on every machine.

## How this project uses it

- **Automatically**, never by user invocation: every writer of `CHANGELOG.md`,
  `docs/release-notes/v*.md`, `site/index.html` or UI strings runs it in the skill's own
  「自動化工作流模式 → 跳過確認、事後摘要」 and reports the summary (Rule 9 has the full contract).
- The slash command still works (`/speak-human-tw`) for ad-hoc text; that is upstream behaviour and
  was left as is.
- NOT applied to PR descriptions, GitHub issues, commit messages, review-bot replies or anything
  under `.claude/` — engineers are the audience there.

## Updating

Re-copy the files listed above from a newer upstream commit, bump the version and commit hash in
this file, and re-run the CHANGELOG pass on `## 未釋出` once to check nothing in the new rule set
disagrees with `user-facing-copy.md` Rules 8–9 (this project's rules win on conflict).
