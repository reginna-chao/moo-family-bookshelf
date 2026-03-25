# Project Init — Adapt Skills & Rules to a New Project

## Role

Meta-skill that reads a project's architecture docs and plan, then adapts the base `.claude/skills/` and `.claude/rules/` templates to fit the specific project.

## When to Use

When you copy this `.claude/` skeleton into a new project and need to customize the skills and rules for that project's tech stack, structure, and conventions.

## Invocation

```
/project-init
```

No arguments needed. The skill reads project context automatically.

## Process

### Step 1: Discover Project Context

Read the following files (skip if not found):

1. `AGENTS.md` or `CLAUDE.md` — repo guidelines
2. `docs/project-plan.md` or `README.md` — project overview, tech stack, roadmap
3. `docs/architecture.md` — system architecture, data model, API design
4. `package.json` (root and sub-packages) — dependencies, scripts
5. `tsconfig.json` / `vite.config.ts` / `wrangler.toml` — build configuration

### Step 2: Analyze & Map

From the discovered context, extract:

| Item | Where to Apply |
|------|---------------|
| **Tech stack** (framework, language, DB, hosting) | Rules: `frontend.md`, `backend.md` |
| **Project structure** (directory layout) | Rules: `frontend.md`, `backend.md` |
| **Build/dev commands** (`pnpm dev`, `pnpm test`, etc.) | Rules: all, Skills: team-leads, coders, testers |
| **Testing tools** (Vitest, Jest, Playwright, etc.) | Rules: `test.md`, Skills: testers |
| **API design** (REST, GraphQL, endpoints) | Rules: `backend.md`, Skills: `be-coder` |
| **Data model** (DB schema, KV patterns, etc.) | Rules: `backend.md`, Skills: `be-coder`, `be-tester` |
| **UI patterns** (component library, styling approach) | Rules: `frontend.md`, Skills: `fe-coder` |
| **State management** (Redux, Zustand, Context, etc.) | Rules: `frontend.md`, Skills: `fe-coder` |
| **CI/CD pipeline** | Rules: `global.md` |
| **Naming conventions** | Rules: `global.md` |

### Step 3: Propose Changes

Present a table of proposed changes to the user:

```
| File | Section | Action | Summary |
|------|---------|--------|---------|
| .claude/rules/frontend.md | Tech Stack | Update | React 19 + Vite → Next.js 15 |
| .claude/rules/backend.md | Project Structure | Rewrite | Cloudflare Workers → Express + PostgreSQL |
| .claude/skills/be-coder/SKILL.md | Coding Rules | Update | Add ORM conventions |
| ... | ... | ... | ... |
```

**Wait for user confirmation before applying.**

### Step 4: Apply Changes

Update each file according to the approved changes. For each file:
1. Read the current base template content.
2. Replace project-specific sections (tech stack, structure, commands, patterns).
3. Keep generic sections intact (workflow phases, role definitions, review dimensions).
4. Write the updated file.

### Step 5: Verify & Report

1. List all files updated.
2. Highlight any gaps (e.g., "No testing framework detected — `test.md` left as placeholder").
3. Suggest next steps (e.g., "Run `/team-lead` to start your first task").

## What This Skill Updates

### Rules (`.claude/rules/`)

| File | What Gets Customized |
|------|---------------------|
| `global.md` | Language policy, commit conventions, decision framework |
| `frontend.md` | Tech stack, project structure, coding conventions, commands, state management |
| `backend.md` | Tech stack, project structure, API design, DB/storage patterns, commands |
| `test.md` | Framework & tools, test locations, coverage targets, mock policy |

### Skills (`.claude/skills/`)

| Skill | What Gets Customized |
|-------|---------------------|
| `fe-coder` | Coding rules, framework conventions, boundary (working directory) |
| `fe-tester` | Test tools, mock policy, test structure |
| `fe-review` | Review dimensions adjusted for framework |
| `be-coder` | Coding rules, framework conventions, DB/API patterns |
| `be-tester` | Test tools, integration test setup, key scenarios |
| `be-review` | Review dimensions adjusted for backend stack |
| `fe-team-lead` | Verification commands |
| `be-team-lead` | Verification commands |
| `team-lead` | Verification commands |

## What This Skill Does NOT Change

- Workflow phases (the development lifecycle is universal).
- Role boundaries (coders don't test, testers don't code).
- Review output format (CRITICAL / SUGGESTION structure).
- Team hierarchy (team-lead → fe/be-team-lead → coder/tester/review).

## Template Base

This skill assumes the `.claude/` directory follows this base structure:

```
.claude/
├── rules/
│   ├── global.md
│   ├── frontend.md
│   ├── backend.md
│   └── test.md
└── skills/
    ├── team-lead/SKILL.md
    ├── fe-team-lead/SKILL.md
    ├── be-team-lead/SKILL.md
    ├── fe-coder/SKILL.md
    ├── fe-tester/SKILL.md
    ├── fe-review/SKILL.md
    ├── be-coder/SKILL.md
    ├── be-tester/SKILL.md
    ├── be-review/SKILL.md
    └── project-init/SKILL.md    # this file (stays unchanged)
```

To use on a new project: copy the entire `.claude/` directory, then run `/project-init`.
