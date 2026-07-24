# /develop Reference: DESIGN Orchestration

For DESIGN-intent requests (brand assets, add-icon, or visual-style exploration). You (the `/develop` orchestrator) triage and align direction with the user, then dispatch the **`designer`** agent for actual asset production, and finish with Review & Deliver. **Never create SVG / `.pen` / design assets yourself** — the `designer` agent does, routing internally by asset type (see `.claude/agents/designer.md`). See `SKILL.md` §2 for stop discipline.

## Mode triage

| User says | Mode |
| --- | --- |
| 「我要 favicon / touch icon / OG image / banner / logo」 | **Brand assets** — specific list |
| 「幫專案設計品牌資源」 | **Brand assets** — full set |
| 「我需要一個 bookmark icon」「介面多加一個 share icon」 | **Add icon** — single UI icon |
| 「不喜歡現在的風格 / 配色」「想討論視覺方向」「不確定該用什麼」 | **Style consultation** |

---

## Mode 1: Brand Assets

### Phase 1 — Scope & Brief
1. **Confirm the asset list** — only what the user asked for. Map each to how the `designer` agent will make it (favicon/logo/app icon = SVG via logo ref; UI icon set = SVG via icon ref; README banner / OG / social = SVG via banner ref).
2. **Check existing brand** — `ls assets/ public/ extension/public/ site/ 2>/dev/null`; extract any existing logo, brand colors (CSS/Tailwind), icon style. Reuse — don't recreate what exists.
3. **Compile a focused brief**: existing brand (logo path / colors / style), assets to create, platform constraints.
4. **Present the brief. Wait for user confirmation.**

### Phase 2 — Delegate to `designer`
- **Logo needed (none exists):** dispatch `designer` for the logo first → present → user approves → then dispatch the rest in parallel carrying the approved brand forward.
- **Logo exists (reuse):** dispatch the needed `designer` calls in parallel, each given the existing logo/colors as `context`.
- Dispatch template — pass `request` (the specific asset) + `context` (project, brand reference path, palette, style keywords).

→ Continue to **Review & Deliver**.

---

## Mode 2: Add Icon

### Phase 1 — Context check
1. Find the existing set: `ls assets/icons/ src/assets/icons/ public/icons/ extension/public/ 2>/dev/null`.
2. Have the `designer` agent (or a quick read) extract current style: stroke width, linecap/linejoin, viewBox, color approach (`currentColor`?), filled/outlined.
3. Present findings (location, count, style, grid) + the requested icon. Confirm if non-trivial; skip the ceremony if straightforward.

### Phase 2 — Delegate
Dispatch `designer` with the specific icon(s), explicit style-matching instructions, and the path to existing icons for reference. For a single icon it produces 2–3 targeted options rather than a full set.

→ Continue to **Review & Deliver**.

---

## Mode 3: Style Consultation

### Phase 1 — Understand the concern (don't jump to solutions)
Ask open-ended: 「現在的風格哪裡不對？太嚴肅？太花？太無聊？」「想要的感覺是？」「有沒有喜歡的 app/網站風格？」. Audit existing CSS/Tailwind (colors, fonts, spacing), existing assets, UI components. Identify the gap.

### Phase 2 — Explore directions
Present **3 distinct text mood boards** (Colors / Font / Feel / Icons / Similar-to). You may produce these yourself — they are text, not assets.

### Phase 3 — Refine
Mix/iterate per feedback ("A 的配色 + B 的 icon 風格"); propose 3 new if all rejected. Iterate until 「OK, 就這個」.

### Phase 4 — Produce (optional)
Ask 「要開始製作嗎？需要哪些資產？」. Yes → switch to **Mode 1** with the agreed direction as the brief (dispatch `designer`). No → persist the agreed direction by dispatching the `designer` agent with the decided palette / font / icon-style / references as `context`, asking it to write `.skill-archive/design/style-direction.md`. (`/develop` never writes files itself — see `SKILL.md` §1; the `designer` agent has `Write`.)

→ If producing, continue to **Review & Deliver**.

---

## Review & Deliver (shared — always the final stage)

### Review
After the `designer` agent(s) return:
1. **Asset inventory** table — asset / file / status.
2. **Consistency check** (multiple assets): same palette? compatible weight/style? logo recognizable at all sizes?
3. **Integration checklist** — only items relevant to what was produced: favicon `<link>`, apple-touch-icon tag, PWA manifest `icons`, Chrome Extension `manifest.json` icons, OG meta tags, README banner markdown, icon sprite import.
4. **Present. Wait for approval.**

### Deliver
1. **Copy assets** to project (suggest paths, confirm with user): `cp {source} {destination}`.
2. **Generate integration snippets** — only for approved assets:
   - Favicon + touch icon `<link>` tags; OG `<meta property="og:image" ...>` (1200×630); README banner `<p align="center"><img ...></p>`; PWA manifest `icons` array (192/512/maskable).
3. **Retro offer** — before the commit ask, offer the run retrospective ONCE (user decides; never auto-run; declined → don't re-offer). On yes, read `references/retro.md` and follow it in this session; the report rides along in the same commit. Proposals are applied later by `/distill`, never in-run.
4. **Ask the user about committing** the new assets + retro report, if any. (Designs iterate — never commit without go-ahead.)

## Rules
- **Never create assets directly** — always dispatch the `designer` agent.
- **Always triage first.** **Check existing assets** before creating. **Review & Deliver is mandatory.**
- Don't over-ask in Add-icon; don't under-ask in Style consultation.
- **Carry brand forward** — first asset's approved style informs the rest.
