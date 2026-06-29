# Designer Reference: UI Icons (SVG)

The designer agent reads this reference on demand when a request is for UI icons — an icon set, toolbar / navigation / tab bar icons, status icons, or any consistent icon family for an interface. It describes how to create consistent UI icon sets through SVG generation for app and web interfaces.

## Scope

| This reference handles | Use another reference / agent |
|---|---|
| Toolbar / action bar icons | Logos → logo reference |
| Navigation / tab bar icons | App icons → logo reference |
| Status / indicator icons | Banners → banner reference |
| Menu / list item icons | |
| Empty state illustrations (simple) | |
| Badge / chip icons | |

## Output Location

All generated files saved to `.skill-archive/designer/icon/<yyyy-mm-dd-summaryname>/`:

```
.skill-archive/designer/icon/2026-03-26-moo-bookshelf-ui/
  individual/
    home.svg
    search.svg
    settings.svg
    bookmark.svg
    bookmark-filled.svg
    ...
  sprite.svg              # SVG symbol sprite (all icons)
  preview.html            # Visual gallery
  final/
    sprite.svg
    individual/           # Copy of approved icons
```

## Design Grid & Specifications

### Base Grid: 24 × 24 dp

All icons are designed on a 24×24 grid. This is the industry standard used by Material Design, Lucide, Heroicons, and Phosphor.

```
┌────────────────────────┐
│  ┌──────────────────┐  │  Outer: 24×24 (full canvas)
│  │                  │  │  Padding: 2dp on each side
│  │   Active Area    │  │  Active: 20×20 (content area)
│  │    20 × 20       │  │
│  │                  │  │  Keyline shapes:
│  └──────────────────┘  │    Circle: r=10, centered
│                        │    Square: 18×18, centered (1dp margin)
└────────────────────────┘    Rectangle: 20×16 or 16×20
```

### Stroke Specifications

| Property | Value |
|----------|-------|
| Stroke width | **2px** (default) or **1.5px** (for denser UIs) |
| Stroke linecap | `round` |
| Stroke linejoin | `round` |
| Fill | `none` (outlined) or `currentColor` (filled variant) |
| Corner radius | 1-2px for internal corners |

**IMPORTANT:** Pick ONE stroke width for the entire set and use it consistently.

### Optical Alignment Rules

- **Circle shapes** extend to the full 20×20 active area (they appear smaller optically)
- **Square shapes** are inset 1dp (18×18) so they appear the same visual weight as circles
- **Tall/narrow icons** (e.g., pencil) may extend to 20dp height but stay ≤16dp wide
- **Wide icons** (e.g., landscape) may extend to 20dp width but stay ≤16dp tall
- **Pointed shapes** (triangles, arrows) may overshoot by 1dp to appear balanced

### Color Convention

All icons should use `currentColor` so they inherit the text color from CSS:

```xml
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
```

## Workflow

### Step 1: Discovery & Requirements

Before generating, the designer agent gathers requirements from the user:

1. **Icon list** — Which icons are needed?
   - Provide names (e.g., home, search, settings, bookmark, share, user, bell, ...)
   - Or describe by function (e.g., "navigation bar needs 5 icons: home, explore, library, profile, settings")

2. **Style:**
   - Outlined (stroke only) — default, recommended
   - Filled (solid fills)
   - Duotone (filled with lighter secondary color)
   - Both outlined + filled variants

3. **Stroke width:**
   - 2px (standard, recommended)
   - 1.5px (lighter, for dense UIs)

4. **Size variants needed:**
   - 24dp only (default)
   - 24dp + 20dp (compact)
   - 24dp + 16dp (small contexts)

5. **Usage context:**
   - Web app (SVG inline or sprite)
   - React component icons
   - Mobile app (SVG files)
   - Figma/design handoff

**Wait for user confirmation before proceeding!**

### Step 2: Generate Icon Set

Generate all requested icons following the grid specs.

**SVG template (outlined):**
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <title>icon-name</title>
  <!-- paths here -->
</svg>
```

**SVG template (filled):**
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
     fill="currentColor" stroke="none">
  <title>icon-name-filled</title>
  <!-- paths here -->
</svg>
```

**Design principles:**
- Each icon should be recognizable at 16px display
- Consistent visual weight across all icons in the set
- Avoid fine details that break at small sizes
- Use the minimum number of paths needed
- Align to pixel grid (integer coordinates where possible) for sharp rendering

**Naming:** `{icon-name}.svg`, `{icon-name}-filled.svg`

### Step 3: Create SVG Symbol Sprite

Combine all icons into a single sprite file for efficient loading:

```xml
<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="icon-home" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 12l9-9 9 9"/>
    <path d="M9 21V12h6v9"/>
  </symbol>

  <symbol id="icon-search" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <path d="M21 21l-4.35-4.35"/>
  </symbol>

  <!-- ... more symbols ... -->
</svg>
```

**Usage in HTML:**
```html
<svg width="24" height="24"><use href="sprite.svg#icon-home"/></svg>
```

**Usage in React:**
```tsx
const Icon = ({ name, size = 24 }: { name: string; size?: number }) => (
  <svg width={size} height={size}>
    <use href={`/icons/sprite.svg#icon-${name}`} />
  </svg>
);
```

### Step 4: Create HTML Preview Gallery

Generate a `preview.html` to display the full icon set:

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <title>Icon Set Preview — {project}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 0.5rem; color: #333; }
    .subtitle { text-align: center; color: #888; margin-bottom: 2rem; font-size: 0.875rem; }
    h2 { color: #555; margin: 2rem 0 1rem; }
    .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 1rem; max-width: 1200px; margin: 0 auto; }
    .icon-card { background: white; border-radius: 8px; padding: 1.25rem 0.75rem; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.06); transition: all 0.15s; cursor: default; }
    .icon-card:hover { background: #f0f4ff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .icon-card svg, .icon-card img { width: 24px; height: 24px; margin-bottom: 0.5rem; color: #333; }
    .icon-card .name { font-size: 0.75rem; color: #888; word-break: break-all; }

    /* Size comparison */
    .size-compare { display: flex; align-items: end; gap: 2rem; margin: 1rem 0; }
    .size-compare .item { text-align: center; }
    .size-compare .item svg, .size-compare .item img { color: #333; }
    .size-compare .label { font-size: 0.7rem; color: #aaa; margin-top: 0.25rem; }

    /* Dark mode */
    .dark-section { background: #1e1e2e; padding: 2rem; border-radius: 12px; margin-top: 2rem; }
    .dark-section h2 { color: #eee; }
    .dark-section .icon-card { background: #2a2a3e; }
    .dark-section .icon-card svg, .dark-section .icon-card img { color: #e0e0e0; }
    .dark-section .icon-card .name { color: #888; }

    /* Grid overlay toggle */
    .grid-overlay { position: relative; display: inline-block; }
    .grid-overlay::after { content: ''; position: absolute; top: 2px; left: 2px; right: 2px; bottom: 2px; border: 1px dashed rgba(99,102,241,0.3); pointer-events: none; }

    /* Consistency check row */
    .consistency-row { display: flex; gap: 4px; align-items: center; margin: 1rem 0; padding: 1rem; background: white; border-radius: 8px; flex-wrap: wrap; }
    .consistency-row svg, .consistency-row img { width: 24px; height: 24px; color: #333; }
  </style>
</head>
<body>
  <h1>{project} UI Icon Set</h1>
  <p class="subtitle">{stroke_width}px stroke · {icon_count} icons · 24×24 grid</p>

  <!-- Outlined icons -->
  <h2>Outlined</h2>
  <div class="icon-grid">
    <div class="icon-card">
      <img src="individual/home.svg">
      <div class="name">home</div>
    </div>
    <!-- ... -->
  </div>

  <!-- Filled variants (if generated) -->
  <h2>Filled</h2>
  <div class="icon-grid">
    <div class="icon-card">
      <img src="individual/home-filled.svg">
      <div class="name">home-filled</div>
    </div>
    <!-- ... -->
  </div>

  <!-- Size comparison -->
  <h2>尺寸比較</h2>
  <div class="size-compare">
    <div class="item"><img src="individual/home.svg" width="16" height="16"><div class="label">16dp</div></div>
    <div class="item"><img src="individual/home.svg" width="20" height="20"><div class="label">20dp</div></div>
    <div class="item"><img src="individual/home.svg" width="24" height="24"><div class="label">24dp</div></div>
    <div class="item"><img src="individual/home.svg" width="32" height="32"><div class="label">32dp</div></div>
    <div class="item"><img src="individual/home.svg" width="48" height="48"><div class="label">48dp</div></div>
  </div>

  <!-- Consistency check — all icons side by side -->
  <h2>一致性檢查</h2>
  <p style="font-size:0.8rem;color:#888;margin-bottom:0.5rem;">所有 icon 並排，檢查視覺重量是否一致</p>
  <div class="consistency-row">
    <img src="individual/home.svg">
    <img src="individual/search.svg">
    <!-- ... all icons inline ... -->
  </div>

  <!-- Dark mode -->
  <div class="dark-section">
    <h2>深色主題</h2>
    <div class="icon-grid">
      <div class="icon-card">
        <img src="individual/home.svg">
        <div class="name">home</div>
      </div>
      <!-- ... -->
    </div>
  </div>
</body>
</html>
```

Open in browser:
- Windows: `start preview.html`
- macOS/Linux: `open preview.html`

### Step 5: Iterate with User

Ask the user to review:
- 「所有 icon 的視覺重量是否一致？」
- 「在一致性檢查中有沒有特別突兀的？」
- 「在 16dp 小尺寸下是否清楚辨識？」
- 「哪些需要調整？」

Based on feedback:
1. Regenerate specific icons
2. Ensure consistency across the full set
3. Update sprite.svg and preview.html
4. Repeat until user approves

### Step 6: Finalize & Export

Once the user approves the full set:

**6a. Create final directory:**
```bash
mkdir -p .skill-archive/designer/icon/<date-name>/final/individual
```

**6b. Copy all approved icons + sprite:**
```bash
cp individual/*.svg final/individual/
cp sprite.svg final/sprite.svg
```

**6c. Generate React component (optional):**

```tsx
// Icon.tsx
import type { SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  name: string;
  size?: number;
}

export function Icon({ name, size = 24, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...props}>
      <use href={`/icons/sprite.svg#icon-${name}`} />
    </svg>
  );
}
```

**6d. Copy to project (if requested):**
```bash
mkdir -p src/assets/icons
cp final/sprite.svg src/assets/icons/sprite.svg
cp final/individual/*.svg src/assets/icons/
```

### Step 7: Deliver Summary

Present final deliverables:

| File | Description |
|------|-------------|
| `final/sprite.svg` | Combined symbol sprite |
| `final/individual/*.svg` | Individual icon files |
| React component | `Icon.tsx` (if requested) |
| CSS usage | `<svg><use href="..."/></svg>` |

All files in: `.skill-archive/designer/icon/<yyyy-mm-dd-summaryname>/final/`

---

## Design Reference

### Common UI Icon Categories

**Navigation:**
home, search, menu, back, forward, close, more-horizontal, more-vertical

**Actions:**
edit, delete, share, download, upload, copy, paste, undo, redo, save

**Status:**
check, x, alert-triangle, info, help-circle, bell, bell-off

**Media:**
play, pause, skip-forward, skip-back, volume, volume-off, image, camera

**Content:**
file, folder, book, bookmark, tag, archive, inbox, mail

**User:**
user, users, settings, lock, unlock, log-in, log-out

**Communication:**
message, send, phone, video

### Pixel-Perfect Tips

- Prefer even-number coordinates for 2px stroke (stroke centered on pixel boundary)
- For 1.5px stroke, half-pixel offsets (e.g., `x="0.5"`) may help on 2x displays
- Horizontal/vertical lines: always align to full or half pixel
- Diagonal lines: don't need pixel alignment (anti-aliasing handles them)
- Circles: center on integer coordinates, use integer radius

### SVG Optimization Checklist

- [ ] Remove unnecessary `xmlns:xlink` if not using `<use>`
- [ ] Use `currentColor` instead of hardcoded colors
- [ ] Round coordinates to max 2 decimal places
- [ ] Combine adjacent paths where logical
- [ ] Remove default attribute values (`opacity="1"`, `fill-rule="nonzero"`)
- [ ] Each icon under 500 bytes ideally
