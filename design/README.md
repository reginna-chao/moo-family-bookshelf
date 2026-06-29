# design/

UI mockups for MooFamily Bookshelf, authored with [Pencil.dev](https://pencil.dev) and stored as `.pen` files.

Designs are produced by the `designer` agent (`.claude/agents/designer.md`, Pencil reference at `.claude/agents/references/designer/pencil-mockup.md`) — dispatched by `/develop` for UI-layout mockups in Claude Code.

## Folder layout

| Folder | Surface |
|--------|---------|
| `extension/` | Chrome Extension Dialog (overlay on Readmoo pages) and Extension Settings |
| `pwa/` | PWA mobile viewer |
| `site/` | GitHub Pages landing page (`site/index.html`) |
| `flows/` | Cross-surface user journeys (e.g. Extension → PWA invite flow) |

Inside each surface, group designs by feature in kebab-case folders (e.g. `extension/borrow-flow/borrow-request.pen`).

## Notes

- `.pen` files are encrypted; open and edit via the Pencil VS Code extension only — do NOT edit them as plain text.
- Save with `Ctrl+S` (Windows / Linux) / `Cmd+S` (macOS) in VS Code to persist Pencil canvas changes to disk.
- Do not export PNG/JPG into this folder. Generate previews via the Pencil MCP `get_screenshot` tool when needed for PR descriptions.
