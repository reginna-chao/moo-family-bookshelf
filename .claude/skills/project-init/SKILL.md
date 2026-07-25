---
name: project-init
description: >
  Meta-skill: reads project architecture docs and plan, then adapts all base .claude/skills/ and .claude/rules/
  templates to fit the specific project's tech stack, structure, and conventions.
  TRIGGER when: user explicitly invokes /project-init, or asks to customize/adapt skills for a new project.
  DO NOT TRIGGER when: user is working on features, writing code, or reviewing — this is a one-time setup tool.
argument-hint: (no arguments needed, reads project context automatically)
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(cat*), Bash(ls*)
model: opus
---

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

| Item                                                   | Where to Apply                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| **Tech stack** (framework, language, DB, hosting)      | Rules: `frontend.md`, `backend.md`                                  |
| **Project structure** (directory layout)               | Rules: `frontend.md`, `backend.md`                                  |
| **Build/dev commands** (`pnpm dev`, `pnpm test`, etc.) | Rules: all; Agents: `coder`, `tester` (scope map); Skill: `develop` |
| **Testing tools** (Vitest, Jest, Playwright, etc.)     | Rules: `test.md`; Agent: `tester`                                   |
| **API design** (REST, GraphQL, endpoints)              | Rules: `backend.md`; Agent: `coder` (backend scope)                 |
| **Data model** (DB schema, KV patterns, etc.)          | Rules: `backend.md`; Agents: `coder`, `tester` (backend scope)      |
| **UI patterns** (component library, styling approach)  | Rules: `frontend.md`; Agent: `coder` (frontend scope)               |
| **State management** (Redux, Zustand, Context, etc.)   | Rules: `frontend.md`; Agent: `coder` (frontend scope)               |
| **CI/CD pipeline**                                     | Rules: `global.md`                                                  |
| **Naming conventions**                                 | Rules: `global.md`                                                  |

### Step 3: Propose Changes

Present a table of proposed changes to the user:

```
| File | Section | Action | Summary |
|------|---------|--------|---------|
| .claude/rules/frontend.md | Tech Stack | Update | React 19 + Vite → Next.js 15 |
| .claude/rules/backend.md | Project Structure | Rewrite | Cloudflare Workers → Express + PostgreSQL |
| .claude/agents/coder.md | Scope Map (backend) | Update | Add ORM conventions |
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
3. Suggest next steps (e.g., "Run `/develop` to start your first task").

## What This Skill Updates

### Rules (`.claude/rules/`)

| File          | What Gets Customized                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| `global.md`   | Language policy, commit conventions, decision framework                       |
| `frontend.md` | Tech stack, project structure, coding conventions, commands, state management |
| `backend.md`  | Tech stack, project structure, API design, DB/storage patterns, commands      |
| `test.md`     | Framework & tools, test locations, coverage targets, mock policy              |

### Agents (`.claude/agents/`)

| Agent              | What Gets Customized                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `coder`            | Scope map (frontend/backend working dirs, verify commands), coding rules    |
| `tester`           | Scope map (test dirs, commands), test tools, mock policy, key scenarios     |
| `reviewer`         | Review dimensions per scope (frontend framework / backend stack)            |
| `designer`         | Triage table + surface frames; reference files under `references/designer/` |
| `security-auditor` | Audit dimensions adjusted for the stack (extension / API / crypto surfaces) |

### Skills (`.claude/skills/`)

| Skill          | What Gets Customized                                                  |
| -------------- | --------------------------------------------------------------------- |
| `develop`      | Verification commands; scope tagging; phase commands in `references/` |
| `project-init` | (this file — stays unchanged)                                         |

## What This Skill Does NOT Change

- Workflow phases (the development lifecycle is universal).
- Role boundaries (coders don't test, testers don't code, reviewer is read-only).
- Review output format (CRITICAL / SUGGESTION structure).
- Orchestration model (`develop` dispatches the `coder` / `tester` / `reviewer` / `security-auditor` / `designer` agents directly; the Fix Cycle lives in `develop`).

## Template Base

This skill assumes the `.claude/` directory follows this base structure:

```
.claude/
├── rules/
│   ├── global.md
│   ├── frontend.md
│   ├── backend.md
│   └── test.md
├── agents/
│   ├── coder.md
│   ├── tester.md
│   ├── reviewer.md
│   ├── designer.md
│   ├── security-auditor.md
│   └── references/designer/{pencil-mockup,logo,icon,banner}.md
└── skills/
    ├── develop/
    │   ├── SKILL.md             # intent router (code vs design)
    │   └── references/{code-cycle,design}.md
    ├── bump-ver/SKILL.md
    └── project-init/SKILL.md    # this file (stays unchanged)
```

To use on a new project: copy the entire `.claude/` directory, then run `/project-init`.
