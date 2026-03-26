---
name: logo-creator
description: >
  Create logos, app icons, favicons, and touch icons for side projects using SVG generation.
  Supports Google Play adaptive icon spec, Apple Touch Icon, PWA manifest icons, and favicon.
  TRIGGER when: user wants to create a logo, favicon, app icon, touch icon, brand mark, mascot, emblem, or design a logo.
  DO NOT TRIGGER when: user wants UI icons for interface (use icon-creator), banners/headers (use banner-creator), or OG images (use banner-creator).
argument-hint: <project name or brand description>
allowed-tools: Read, Write, Edit, Bash(open *), Bash(start *), Bash(ls *), Bash(mkdir *), Bash(cp *), Bash(npx sharp-cli *), Bash(node *), Glob, Grep
---

# Logo Creator Skill

Create professional logos and app icons through SVG generation with an iterative design process.

## Scope

| This skill handles | Use another skill |
|---|---|
| Logo / brand mark | UI icons → `/icon-creator` |
| Favicon (SVG/ICO) | Banners / headers → `/banner-creator` |
| Apple Touch Icon (180×180) | OG Image (1200×630) → `/banner-creator` |
| Google Play Icon (512×512) | |
| Android Adaptive Icon (fg/bg layers) | |
| PWA manifest icons (192/512) | |
| Chrome Extension icon (128) | |

## Output Location

All generated files saved to `.skill-archive/logo-creator/<yyyy-mm-dd-summaryname>/`:

```
.skill-archive/logo-creator/2026-03-26-moo-bookshelf/
  logo-01.svg
  logo-02.svg
  ...
  preview.html
  final/
    logo.svg                  # Master vector
    favicon.svg               # Simplified for small sizes
    logo-maskable.svg         # With safe zone padding (adaptive icon)
    logo-foreground.svg       # Adaptive icon foreground layer
    logo-background.svg       # Adaptive icon background layer
```

## Workflow

### Step 1: Discovery & Requirements

Before generating, gather requirements from user:

1. **Project/Brand name** — What is the logo for?
2. **Style preference:**
   - Minimalist / flat design (recommended for side projects)
   - Geometric / abstract
   - Monogram / lettermark
   - Playful / rounded
   - Technical / sharp
   - Pixel art (SVG grid)
   - Mascot / character (simple)
3. **Target platforms** (determines export set):
   - Web only (favicon + og)
   - PWA (favicon + manifest icons + touch icon)
   - Chrome Extension (favicon + 16/48/128 icons)
   - Android (Google Play 512 + adaptive icon)
   - Full set (all of the above)
4. **Color preferences:**
   - Monochrome (black & white)
   - Specific brand colors (provide hex)
   - Color palette suggestion from AI
5. **Background requirement:**
   - Transparent (web/PWA)
   - Solid color required (Google Play — no transparency allowed)

**Wait for user confirmation before proceeding!**

### Step 2: Generate SVG Variations

Generate 5-8 distinct SVG logo variations. Each SVG should:

- Use `viewBox="0 0 512 512"` for consistent sizing
- Be self-contained (no external fonts or images)
- Use clean, semantic SVG elements (`<circle>`, `<rect>`, `<path>`, `<text>`, `<g>`)
- Include a `<title>` element for accessibility
- Keep file size under 5KB
- **Keep all important content within the safe zone** (inner 66.67% — see App Icon Specs below)

**Design Guidelines:**

```
Minimalist:    Simple shapes, max 3 colors, generous whitespace
Geometric:     Triangles, hexagons, overlapping shapes, gradients OK
Monogram:      1-2 letters, custom letterforms, bold weight
Playful:       Rounded corners, warm colors, friendly feel
Technical:     Sharp angles, monospace font feel, grid-aligned
Pixel art:     Grid of <rect> elements, 16x16 or 32x32 logical grid
Mascot:        Simple character, expressive, minimal detail
```

**Naming:** `logo-01.svg`, `logo-02.svg`, etc.

### Step 3: Create HTML Preview Gallery

Generate a `preview.html` that displays all SVG variations with platform-specific previews:

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <title>Logo Preview — {project}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 0.5rem; color: #333; }
    .subtitle { text-align: center; color: #888; margin-bottom: 2rem; font-size: 0.875rem; }
    h2 { color: #555; margin: 2rem 0 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1.5rem; max-width: 1200px; margin: 0 auto; }
    .card { background: white; border-radius: 12px; padding: 1.5rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s; }
    .card:hover { transform: translateY(-4px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
    .card img { width: 128px; height: 128px; margin-bottom: 0.75rem; }
    .card .label { font-size: 0.875rem; color: #666; }

    /* Size preview */
    .size-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .size-row .size-item { text-align: center; }
    .size-row img { background: white; border: 1px solid #ddd; border-radius: 4px; display: block; margin-bottom: 0.25rem; }
    .size-row .size-label { font-size: 0.75rem; color: #999; }

    /* Dark background */
    .dark-bg { background: #1a1a2e; padding: 2rem; border-radius: 12px; margin-top: 2rem; }
    .dark-bg .grid .card { background: #16213e; }
    .dark-bg .card .label { color: #aaa; }
    .dark-bg h2 { color: #eee; }

    /* Platform mocks */
    .platform-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1rem; }

    /* Favicon mock — browser tab */
    .tab-mock { background: #dee1e6; border-radius: 8px 8px 0 0; padding: 8px 12px; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #444; max-width: 200px; }
    .tab-mock img { width: 16px; height: 16px; }

    /* Android adaptive icon mock */
    .adaptive-mock { position: relative; width: 192px; height: 192px; margin: 0 auto; }
    .adaptive-circle { width: 192px; height: 192px; border-radius: 50%; overflow: hidden; border: 1px solid #ddd; }
    .adaptive-squircle { width: 192px; height: 192px; border-radius: 25%; overflow: hidden; border: 1px solid #ddd; }
    .adaptive-rounded { width: 192px; height: 192px; border-radius: 35%; overflow: hidden; border: 1px solid #ddd; }
    .adaptive-mock img { width: 100%; height: 100%; object-fit: cover; }

    /* Safe zone overlay */
    .safe-zone-demo { position: relative; display: inline-block; }
    .safe-zone-demo img { width: 256px; height: 256px; }
    .safe-zone-overlay { position: absolute; top: 0; left: 0; width: 256px; height: 256px; border: 2px dashed rgba(255,0,0,0.5); border-radius: 50%; pointer-events: none; }
    .safe-zone-inner { position: absolute; top: 42.67px; left: 42.67px; width: 170.67px; height: 170.67px; border: 2px solid rgba(0,200,0,0.6); border-radius: 50%; pointer-events: none; }

    /* Apple touch icon mock */
    .touch-icon-mock { width: 60px; height: 60px; border-radius: 13.4px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.2); display: inline-block; }
    .touch-icon-mock img { width: 100%; height: 100%; }

    /* Google Play mock */
    .play-card { background: white; border-radius: 8px; padding: 1rem; display: flex; align-items: center; gap: 1rem; box-shadow: 0 1px 4px rgba(0,0,0,0.1); max-width: 400px; }
    .play-card img { width: 64px; height: 64px; border-radius: 16px; }
    .play-card .info { }
    .play-card .app-name { font-weight: 600; font-size: 1rem; }
    .play-card .app-dev { font-size: 0.8rem; color: #666; }
  </style>
</head>
<body>
  <h1>{project} Logo 預覽</h1>
  <p class="subtitle">點選喜歡的方案編號回饋</p>

  <!-- All variations grid -->
  <h2>所有方案</h2>
  <div class="grid">
    <div class="card">
      <img src="logo-01.svg" alt="Logo variation 1">
      <div class="label">#1</div>
    </div>
    <!-- ... repeat for each logo ... -->
  </div>

  <!-- Size preview -->
  <h2>尺寸預覽</h2>
  <div class="size-row">
    <div class="size-item"><img src="logo-01.svg" width="16" height="16"><span class="size-label">16px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="32" height="32"><span class="size-label">32px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="48" height="48"><span class="size-label">48px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="64" height="64"><span class="size-label">64px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="128" height="128"><span class="size-label">128px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="180" height="180"><span class="size-label">180px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="256" height="256"><span class="size-label">256px</span></div>
    <div class="size-item"><img src="logo-01.svg" width="512" height="512"><span class="size-label">512px</span></div>
  </div>

  <!-- Platform mocks -->
  <h2>平台模擬</h2>
  <div class="platform-grid">
    <!-- Browser tab -->
    <div>
      <h3 style="font-size:0.9rem;color:#888;margin-bottom:0.5rem;">Browser Tab</h3>
      <div class="tab-mock"><img src="logo-01.svg">{project} — Page Title</div>
    </div>

    <!-- Apple touch icon -->
    <div>
      <h3 style="font-size:0.9rem;color:#888;margin-bottom:0.5rem;">iOS Home Screen</h3>
      <div class="touch-icon-mock"><img src="logo-01.svg"></div>
    </div>

    <!-- Google Play store listing -->
    <div>
      <h3 style="font-size:0.9rem;color:#888;margin-bottom:0.5rem;">Google Play Store</h3>
      <div class="play-card">
        <img src="logo-01.svg">
        <div class="info">
          <div class="app-name">{project}</div>
          <div class="app-dev">Developer Name</div>
        </div>
      </div>
    </div>

    <!-- Android adaptive icon shapes -->
    <div>
      <h3 style="font-size:0.9rem;color:#888;margin-bottom:0.5rem;">Adaptive Icon Masks</h3>
      <div style="display:flex;gap:1rem;">
        <div class="adaptive-circle"><img src="logo-01.svg"></div>
        <div class="adaptive-squircle"><img src="logo-01.svg"></div>
        <div class="adaptive-rounded"><img src="logo-01.svg"></div>
      </div>
    </div>
  </div>

  <!-- Safe zone check -->
  <h2>Safe Zone 檢查</h2>
  <p style="color:#888;font-size:0.875rem;margin-bottom:1rem;">綠圈 = safe zone (66.67%)，重要內容必須在綠圈內</p>
  <div style="display:flex;gap:2rem;flex-wrap:wrap;">
    <div class="safe-zone-demo">
      <img src="logo-01.svg">
      <div class="safe-zone-overlay"></div>
      <div class="safe-zone-inner"></div>
    </div>
    <!-- ... repeat for each logo ... -->
  </div>

  <!-- Dark background -->
  <div class="dark-bg">
    <h2>深色背景預覽</h2>
    <div class="grid">
      <div class="card">
        <img src="logo-01.svg" alt="Logo variation 1">
        <div class="label">#1</div>
      </div>
    </div>
  </div>
</body>
</html>
```

Open in browser:
- Windows: `start preview.html`
- macOS/Linux: `open preview.html`

### Step 4: Iterate with User

Ask user which logos they prefer:
- 「你喜歡哪幾個方案？（例如 #2, #5）」
- 「有什麼想調整的地方？」
- 「在 safe zone 預覽中，重要元素是否都在綠圈內？」

Based on feedback:
1. Generate 3-5 refined variations based on favorites
2. Name as `logo-{original}-v{n}.svg` (e.g., `logo-02-v1.svg`)
3. Update preview.html
4. Repeat until user approves

### Step 5: Finalize & Export

Once user approves a logo, generate the target platform assets:

**5a. Create final directory:**
```bash
mkdir -p .skill-archive/logo-creator/<date-name>/final
```

**5b. Master SVG:**
```bash
cp logo-{chosen}.svg final/logo.svg
```

**5c. Generate platform-specific variants** (as separate SVG files):

| Asset | File | Spec |
|-------|------|------|
| Favicon SVG | `final/favicon.svg` | Simplified, icon-only (no text), works at 16px |
| Maskable icon | `final/logo-maskable.svg` | Icon-only (no text), content in inner 80% circle, solid bg |
| Adaptive foreground | `final/logo-foreground.svg` | 108×108dp viewBox, content in 66dp safe zone |
| Adaptive background | `final/logo-background.svg` | 108×108dp viewBox, background only |

**5d. Generate HTML/manifest snippets:**

```html
<!-- Favicon (add to <head>) -->
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
```

```jsonc
// PWA manifest icons
{
  "icons": [
    { "src": "/icons/icon-192.svg", "sizes": "192x192", "type": "image/svg+xml" },
    { "src": "/icons/icon-512.svg", "sizes": "512x512", "type": "image/svg+xml" },
    { "src": "/icons/icon-maskable.svg", "sizes": "512x512", "type": "image/svg+xml", "purpose": "maskable" }
  ]
}
```

```xml
<!-- Chrome Extension manifest.json icons -->
{
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

### Step 5e: SVG → PNG Conversion

Automatically convert SVG assets to PNG for platforms that require raster images.
Do NOT ask the user — just run the conversion as part of the finalize step.

Use `npx sharp-cli` (available via npx, no install needed):

```bash
# Extension icons (from favicon.svg)
npx sharp-cli -i final/favicon.svg -o final/icon-16.png -- resize 16 16
npx sharp-cli -i final/favicon.svg -o final/icon-48.png -- resize 48 48
npx sharp-cli -i final/favicon.svg -o final/icon-128.png -- resize 128 128

# Apple Touch Icon (180×180)
npx sharp-cli -i final/favicon.svg -o final/apple-touch-icon.png -- resize 180 180

# PWA icons
npx sharp-cli -i final/favicon.svg -o final/icon-192.png -- resize 192 192
npx sharp-cli -i final/favicon.svg -o final/icon-512.png -- resize 512 512
npx sharp-cli -i final/logo-maskable.svg -o final/icon-maskable-512.png -- resize 512 512
```

If `sharp-cli` is not available, write a small Node script using `sharp` or `@resvg/resvg-js`.

### Step 6: Deliver Summary

Present final deliverables table based on selected platforms:

**Web:**
| File | Size | Usage |
|------|------|-------|
| `favicon.svg` | scalable | Modern browsers |
| `apple-touch-icon.png` | 180×180 | iOS home screen |
| HTML snippet | — | Copy to `<head>` |

**PWA / Extension:**
| File | Size | Usage |
|------|------|-------|
| `icon-192.svg` | 192×192 | PWA install |
| `icon-512.svg` | 512×512 | PWA splash |
| `icon-maskable.svg` | 512×512 | Adaptive display |
| manifest snippet | — | Copy to `manifest.json` |

**Android (Google Play):**
| File | Size | Usage |
|------|------|-------|
| `icon-512.png` | 512×512 | Store listing (32-bit PNG, sRGB, ≤1024KB) |
| `logo-foreground.svg` | 108dp | Adaptive icon foreground |
| `logo-background.svg` | 108dp | Adaptive icon background |

All files in: `.skill-archive/logo-creator/<yyyy-mm-dd-summaryname>/final/`

---

## App Icon Specifications

### Google Play Store Icon

Reference: [Google Play Icon Design Specifications](https://developer.android.com/distribute/google-play/resources/icon-design-specifications)

| Spec | Value |
|------|-------|
| Size | 512 × 512 px |
| Format | 32-bit PNG, sRGB |
| Max file size | 1024 KB |
| Corner radius | 30% (153.6px) — **applied dynamically, do NOT include** |
| Drop shadow | **Applied dynamically, do NOT include** |
| Transparency | **NOT allowed** — must have solid background |

**Keyline Grid (512×512):**
```
┌─────────────────────────┐
│         margin           │
│   ┌─────────────────┐   │
│   │   ○ circle: r=212│   │  Circle keyline: centered, r=212px
│   │   □ square: 352px│   │  Square keyline: 352×352px centered
│   │   ▭ rect: 384×352│   │  Landscape rect: 384×352px centered
│   │   ▯ rect: 352×384│   │  Portrait rect: 352×384px centered
│   └─────────────────┘   │
│                          │
└─────────────────────────┘
```

### Android Adaptive Icon

| Spec | Value |
|------|-------|
| Full canvas | 108 × 108 dp |
| Visible area | 72 × 72 dp (center) |
| Safe zone | 66 × 66 dp (inner 61%) |
| Outer 18dp | Reserved for system mask/animation |
| Layers | Foreground + Background (both 108×108dp) |

**Mask shapes applied by launchers:**
- Circle (most common)
- Rounded square / squircle
- Teardrop
- Square with rounded corners

**SVG template for adaptive icon foreground (108dp viewBox):**
```xml
<svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg">
  <title>App Icon Foreground</title>
  <!-- Safe zone: inner 66×66dp circle, centered at 54,54 -->
  <!-- All important content must be within: x=21..87, y=21..87 -->
  <g transform="translate(54,54)">
    <!-- Center your artwork here (0,0 = center) -->
  </g>
</svg>
```

**SVG template for adaptive icon background:**
```xml
<svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg">
  <title>App Icon Background</title>
  <rect width="108" height="108" fill="#4F46E5"/>
</svg>
```

### Apple Touch Icon

| Spec | Value |
|------|-------|
| Size | 180 × 180 px |
| Format | PNG (no alpha for home screen) |
| Corner radius | ~17.5% — **applied by iOS, do NOT include** |
| Padding | Keep content within inner ~75% (~135×135 centered) |
| Text | **No text** — icon-only, no brand name or labels |

### Favicon

| Format | Size | Usage |
|--------|------|-------|
| SVG | scalable | Modern browsers (recommended) |
| ICO | 16+32+48 | Legacy browsers |
| PNG 32×32 | 32×32 | Fallback |

**Favicon SVG should be simplified:**
- **No text** — favicon and touch icon must be icon-only, never include brand name or text labels
- Remove fine details that disappear at 16px
- Use bold strokes and shapes
- Test readability at 16×16 display size

### PWA Manifest Icons

| Size | Purpose |
|------|---------|
| 192×192 | Install prompt, home screen |
| 512×512 | Splash screen |
| 512×512 (maskable) | Adaptive display on Android |

### Chrome Extension Icons

| Size | Usage |
|------|-------|
| 16×16 | Favicon, toolbar |
| 48×48 | Extensions management page |
| 128×128 | Chrome Web Store, install dialog |

---

## SVG Best Practices

- **Fonts:** Use `<text>` with generic font families (`sans-serif`, `monospace`) or convert text to `<path>`
- **Colors:** Define as CSS custom properties in `<style>` for easy theming
- **Accessibility:** Include `<title>` and `role="img"` on root `<svg>`
- **Optimization:** Remove unnecessary attributes, use shorthand, combine paths where possible
- **Dark mode:** Consider adding `@media (prefers-color-scheme: dark)` styles
- **Safe zone first:** Always design content within safe zone, then fill background to edges

## Common Patterns

**Monogram with background (app icon ready):**
```xml
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <title>Project Logo</title>
  <!-- Solid background (required for Google Play) -->
  <rect width="512" height="512" fill="#4F46E5"/>
  <!-- Content within safe zone (inner 341px centered) -->
  <text x="256" y="340" text-anchor="middle" font-family="sans-serif"
        font-size="260" font-weight="700" fill="white">P</text>
</svg>
```

**Geometric icon with safe zone awareness:**
```xml
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <title>Project Logo</title>
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366F1"/>
      <stop offset="100%" stop-color="#EC4899"/>
    </linearGradient>
  </defs>
  <!-- Background fills entire canvas -->
  <rect width="512" height="512" fill="url(#g)"/>
  <!-- Content within safe zone (85px..427px) -->
  <path d="M200 210 L256 140 L312 210 L312 360 L200 360Z" fill="white" opacity="0.9"/>
</svg>
```

**Pixel art grid:**
```xml
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <title>Project Logo</title>
  <rect width="16" height="16" fill="#1e293b"/>
  <rect x="6" y="2" width="4" height="2" fill="#60a5fa"/>
  <rect x="4" y="4" width="8" height="2" fill="#60a5fa"/>
  <!-- ... more pixel rows ... -->
</svg>
```
