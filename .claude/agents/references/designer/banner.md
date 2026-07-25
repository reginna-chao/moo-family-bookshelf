# Designer Reference: Banners / OG Images / Headers (SVG)

This reference is read on demand by the `designer` agent (`.claude/agents/designer.md`) when a request is for a banner, header, hero image, OG image, or cover image. It covers professional banner, header, and OG image generation through SVG with an iterative design process. When dispatched for a banner task, the designer agent follows the workflow and conventions below.

## Scope

| This reference handles      | Use another reference / agent      |
| --------------------------- | ---------------------------------- |
| GitHub README banner        | Logos / app icons → logo reference |
| Open Graph image (og:image) | UI icons → icon reference          |
| Twitter/X header            |                                    |
| LinkedIn banner             |                                    |
| Website hero image          |                                    |
| YouTube channel art         |                                    |

## Output Location

All generated files saved to `.skill-archive/designer/banner/<yyyy-mm-dd-summaryname>/`:

```
.skill-archive/designer/banner/2026-03-26-moo-bookshelf/
  banner-01.svg
  banner-02.svg
  ...
  preview.html
  final/
    banner.svg
    og-image.svg
```

## Platform Specifications

| Platform                             | Ratio  | Recommended Size | Notes                                 |
| ------------------------------------ | ------ | ---------------- | ------------------------------------- |
| GitHub README                        | 2:1    | 1280×640         | SVG works natively                    |
| Open Graph (og:image)                | 1.91:1 | 1200×630         | Must convert to PNG/JPG for meta tags |
| Twitter/X header                     | 3:1    | 1500×500         | Upload as PNG                         |
| Twitter/X card (summary_large_image) | 2:1    | 1200×600         | Same as OG in most cases              |
| LinkedIn banner                      | 4:1    | 1584×396         | Upload as PNG                         |
| Website hero                         | 16:9   | 1920×1080        | SVG or responsive                     |
| YouTube channel art                  | 16:9   | 2560×1440        | Safe area: 1546×423 center            |

### Open Graph Image (og:image) Spec

| Spec           | Value                                        |
| -------------- | -------------------------------------------- |
| Size           | 1200 × 630 px                                |
| Ratio          | 1.91:1                                       |
| Format         | PNG or JPG (SVG not supported by crawlers)   |
| Min size       | 600 × 315 (Facebook minimum)                 |
| Max file size  | 5 MB (recommended < 1 MB)                    |
| Text safe area | Keep text within inner 80% to avoid clipping |

**Meta tags:**

```html
<meta property="og:image" content="https://example.com/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="{project} — {tagline}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://example.com/og-image.png" />
```

**Design guidelines for OG images:**

- Text must be large enough to read in thumbnail (≥ 40px at 1200w)
- High contrast between text and background
- Keep critical content centered (platforms crop edges differently)
- Include project name prominently
- Avoid small details — OG images are often shown at ~600×315 or smaller

## Workflow

When the designer agent is dispatched for a banner task, it follows these steps. The banner description or project name comes from the request the designer agent received.

### Step 1: Discovery & Requirements

Before generating, gather requirements from user:

1. **Purpose** — Where will the banner be used? (see Platform Specifications above)

2. **Style preference:**
   - Minimalist / clean
   - Gradient / modern
   - Geometric / abstract
   - Illustrated / artistic
   - Code-themed / technical
   - Pixel art / retro
   - Match existing logo? (provide reference)

3. **Content elements:**
   - Project name (required)
   - Tagline / description
   - Logo (if exists, provide path)
   - Tech stack badges
   - Key visual / illustration

4. **Color preferences:**
   - Existing brand colors (provide hex)
   - Popular palettes: dark theme, ocean, sunset, forest, neon
   - Let AI decide based on project type

**Wait for user confirmation before proceeding!**

### Step 2: Generate SVG Banner Variations

Generate 5-8 distinct banner variations. Each SVG should:

- Use viewBox matching target ratio (e.g., `viewBox="0 0 1280 640"` for GitHub)
- Be self-contained (no external fonts or images)
- Use clean SVG elements with meaningful structure
- Keep file size under 10KB
- **Keep text and critical content within inner 80%** for OG image compatibility

**Design Guidelines:**

```
Minimalist:   Clean typography, single accent color, lots of whitespace
Gradient:     Bold gradient backgrounds, white text, subtle patterns
Geometric:    Abstract shapes, overlapping elements, vibrant palette
Code-themed:  Monospace font, code snippets as decoration, dark bg
Illustrated:  Simple SVG illustrations, character/mascot integration
Pixel art:    Retro grid, limited palette, nostalgic feel
```

**Naming:** `banner-01.svg`, `banner-02.svg`, etc.

### Step 3: Create HTML Preview Gallery

Generate a `preview.html` that displays all banner variations:

```html
<!DOCTYPE html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <title>Banner Preview — {project}</title>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      body {
        font-family: system-ui, sans-serif;
        background: #f5f5f5;
        padding: 2rem;
      }
      h1 {
        text-align: center;
        margin-bottom: 0.5rem;
        color: #333;
      }
      .subtitle {
        text-align: center;
        color: #888;
        margin-bottom: 2rem;
        font-size: 0.875rem;
      }
      h2 {
        color: #555;
        margin: 2rem 0 1rem;
        font-size: 1.1rem;
      }
      .gallery {
        max-width: 1000px;
        margin: 0 auto;
      }
      .card {
        background: white;
        border-radius: 12px;
        padding: 1rem;
        margin-bottom: 1.5rem;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      }
      .card img {
        width: 100%;
        height: auto;
        border-radius: 8px;
        display: block;
      }
      .card .label {
        font-size: 0.875rem;
        color: #666;
        margin-top: 0.5rem;
        text-align: center;
      }

      /* GitHub README mock */
      .readme-mock {
        max-width: 800px;
        margin: 2rem auto;
        background: white;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        padding: 2rem;
      }
      .readme-mock img {
        width: 100%;
        height: auto;
        border-radius: 4px;
        margin-bottom: 1rem;
      }
      .readme-mock h3 {
        font-size: 1.5rem;
        margin-bottom: 0.5rem;
      }
      .readme-mock p {
        color: #656d76;
      }

      /* OG image mock — social card */
      .og-mock {
        max-width: 600px;
        margin: 1rem auto;
        background: white;
        border: 1px solid #ddd;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
      }
      .og-mock img {
        width: 100%;
        height: auto;
        display: block;
      }
      .og-mock .og-info {
        padding: 12px 16px;
      }
      .og-mock .og-domain {
        font-size: 0.75rem;
        color: #888;
        text-transform: uppercase;
      }
      .og-mock .og-title {
        font-size: 1rem;
        font-weight: 600;
        color: #333;
        margin: 4px 0;
      }
      .og-mock .og-desc {
        font-size: 0.85rem;
        color: #666;
      }

      /* Twitter card mock */
      .twitter-mock {
        max-width: 550px;
        margin: 1rem auto;
        background: white;
        border: 1px solid #e1e8ed;
        border-radius: 16px;
        overflow: hidden;
      }
      .twitter-mock img {
        width: 100%;
        height: auto;
        display: block;
      }
      .twitter-mock .tw-info {
        padding: 10px 14px;
      }
      .twitter-mock .tw-domain {
        font-size: 0.8rem;
        color: #536471;
      }
      .twitter-mock .tw-title {
        font-size: 0.95rem;
        font-weight: 600;
        color: #0f1419;
      }

      /* Dark theme */
      .dark-preview {
        background: #0d1117;
        padding: 2rem;
        border-radius: 12px;
        margin-top: 2rem;
      }
      .dark-preview h2 {
        color: #eee;
      }
      .dark-preview .card {
        background: #161b22;
      }
      .dark-preview .card .label {
        color: #aaa;
      }
      .dark-preview .readme-mock {
        background: #0d1117;
        border-color: #30363d;
      }
      .dark-preview .readme-mock h3 {
        color: #f0f6fc;
      }
      .dark-preview .readme-mock p {
        color: #8b949e;
      }
    </style>
  </head>
  <body>
    <h1>{project} Banner 預覽</h1>
    <p class="subtitle">點選喜歡的方案編號回饋</p>

    <!-- All variations -->
    <div class="gallery">
      <div class="card">
        <img src="banner-01.svg" alt="Banner variation 1" />
        <div class="label">#1</div>
      </div>
      <!-- ... repeat ... -->
    </div>

    <!-- GitHub README mock -->
    <h2>GitHub README 模擬</h2>
    <div class="readme-mock">
      <img src="banner-01.svg" alt="README banner" />
      <h3>{project}</h3>
      <p>A brief project description goes here.</p>
    </div>

    <!-- OG image / social share mock -->
    <h2>Social Share 預覽 (Open Graph)</h2>
    <div class="og-mock">
      <img src="banner-01.svg" alt="OG image" />
      <div class="og-info">
        <div class="og-domain">example.com</div>
        <div class="og-title">{project} — Your tagline here</div>
        <div class="og-desc">
          A brief description of the project for social sharing.
        </div>
      </div>
    </div>

    <!-- Twitter card mock -->
    <h2>Twitter Card 預覽</h2>
    <div class="twitter-mock">
      <img src="banner-01.svg" alt="Twitter card" />
      <div class="tw-info">
        <div class="tw-domain">example.com</div>
        <div class="tw-title">{project} — Your tagline here</div>
      </div>
    </div>

    <!-- Dark theme preview -->
    <div class="dark-preview">
      <h2>深色主題預覽 (GitHub Dark)</h2>
      <div class="gallery">
        <div class="card">
          <img src="banner-01.svg" alt="Banner variation 1" />
          <div class="label">#1</div>
        </div>
      </div>
      <h2>GitHub README (Dark)</h2>
      <div class="readme-mock">
        <img src="banner-01.svg" alt="README banner dark" />
        <h3>{project}</h3>
        <p>A brief project description goes here.</p>
      </div>
    </div>
  </body>
</html>
```

Open in browser:

- Windows: `start preview.html`
- macOS/Linux: `open preview.html`

### Step 4: Iterate with User

Ask user which banners they prefer:

- 「你喜歡哪幾個方案？（例如 #2, #5）」
- 「在 OG 預覽中文字是否夠大、夠清楚？」
- 「有什麼想調整的地方？文字、配色、排版？」

Based on feedback:

1. Generate 3-5 refined variations based on favorites
2. Name as `banner-{original}-v{n}.svg` (e.g., `banner-02-v1.svg`)
3. Update preview.html
4. Repeat until user approves

### Step 5: Finalize & Export

Once user approves:

**5a. Create final directory:**

```bash
mkdir -p .skill-archive/designer/banner/<date-name>/final
```

**5b. Copy final SVG:**

```bash
cp banner-{chosen}.svg final/banner.svg
```

**5c. Generate OG-specific variant (if different ratio needed):**

If the banner was designed at 2:1 (GitHub) but OG needs 1.91:1, generate a
variant with `viewBox="0 0 1200 630"` that adjusts the layout.

```bash
# Save as separate file
cp banner-{chosen}.svg final/og-image.svg
# Then edit viewBox and layout in og-image.svg
```

**5d. Generate README snippet:**

```markdown
<!-- Add to top of README.md -->
<p align="center">
  <img src="assets/banner.svg" alt="{project}" width="100%">
</p>
```

**5e. Generate OG meta tags:**

```html
<!-- Add to <head> — NOTE: og:image requires PNG/JPG URL, not SVG -->
<meta property="og:image" content="https://{domain}/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="{project} — {tagline}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://{domain}/og-image.png" />
```

**5f. SVG → PNG Conversion:**

Automatically convert OG image SVG to PNG for social media crawlers.
Do NOT ask the user — just run the conversion as part of the finalize step.

```bash
# OG image (social crawlers require PNG/JPG, not SVG)
npx sharp-cli -i final/og-image.svg -o final/og-image.png -- resize 1200 630
```

If `sharp-cli` is not available, write a small Node script using `sharp` or `@resvg/resvg-js`.

**5g. Copy to project (if requested):**

```bash
mkdir -p assets
cp final/banner.svg assets/banner.svg
cp final/og-image.svg assets/og-image.svg
cp final/og-image.png assets/og-image.png
```

### Step 6: Deliver Summary

Present final deliverables:

| File                 | Description         | Usage                                    |
| -------------------- | ------------------- | ---------------------------------------- |
| `final/banner.svg`   | Vector banner       | GitHub README, website                   |
| `final/og-image.svg` | OG image (1200×630) | Social sharing (convert to PNG for meta) |
| README snippet       | Markdown embed code | Copy to README.md                        |
| OG meta tags         | HTML meta tags      | Copy to `<head>`                         |

All files in: `.skill-archive/designer/banner/<yyyy-mm-dd-summaryname>/`

**Note on OG image format:** Social media crawlers (Facebook, Twitter, Slack, Discord)
do NOT support SVG for og:image. The SVG must be converted to PNG before deployment.
Options: use a build tool, online converter, or `sharp`/`puppeteer` script.

---

## SVG Banner Best Practices

### Typography

- Use `<text>` with generic font families or convert to `<path>` for guaranteed rendering
- Project name: large, bold (`font-weight="700"`, `font-size="48-72"`)
- Tagline: smaller, lighter (`font-weight="400"`, `font-size="20-28"`)
- Align text center or left-third for visual balance
- **OG images: minimum 40px font-size** to remain readable in thumbnails

### Background Patterns

- **Dot grid:** `<pattern>` with small `<circle>` elements
- **Diagonal lines:** `<pattern>` with rotated `<line>` elements
- **Gradient mesh:** Multiple overlapping radial gradients
- **Wave:** Smooth `<path>` curves with gentle fills
- **Grid:** Subtle `<line>` patterns at low opacity

### Color Palettes (popular for side projects)

```
Dark Tech:    bg=#0d1117  accent=#58a6ff  text=#f0f6fc
Ocean:        bg=#0077b6  accent=#00b4d8  text=#caf0f8
Sunset:       bg=#ff6b6b  accent=#feca57  text=#ffffff
Forest:       bg=#2d6a4f  accent=#95d5b2  text=#f0fff0
Neon:         bg=#0f0e17  accent=#ff8906  text=#fffffe
Minimal:      bg=#ffffff  accent=#6366f1  text=#1e293b
Purple:       bg=#1e1b4b  accent=#818cf8  text=#e0e7ff
```

### Layout Patterns

**Centered (most common for README):**

```
┌──────────────────────────────┐
│                              │
│        [Logo]                │
│     Project Name             │
│      tagline here            │
│                              │
└──────────────────────────────┘
```

**Left-aligned with illustration:**

```
┌──────────────────────────────┐
│                              │
│  Project Name      [visual]  │
│  tagline here      [art]     │
│                              │
└──────────────────────────────┘
```

**Badge style:**

```
┌──────────────────────────────┐
│  ┌─────┐                     │
│  │Logo │  Project Name       │
│  └─────┘  A short tagline    │
│           [badge] [badge]    │
└──────────────────────────────┘
```

## Common SVG Patterns

**Gradient background with text:**

```xml
<svg viewBox="0 0 1280 640" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366F1"/>
      <stop offset="100%" stop-color="#EC4899"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="640" fill="url(#bg)"/>
  <text x="640" y="280" text-anchor="middle" font-family="sans-serif"
        font-size="72" font-weight="700" fill="white">Project Name</text>
  <text x="640" y="340" text-anchor="middle" font-family="sans-serif"
        font-size="28" fill="rgba(255,255,255,0.8)">A brief tagline</text>
</svg>
```

**OG image template (1200×630):**

```xml
<svg viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0d1117"/>
  <!-- Text safe area: inner 80% = 120..1080 x 63..567 -->
  <text x="600" y="270" text-anchor="middle" font-family="sans-serif"
        font-size="64" font-weight="700" fill="#f0f6fc">Project Name</text>
  <text x="600" y="340" text-anchor="middle" font-family="sans-serif"
        font-size="28" fill="#8b949e">Your awesome tagline here</text>
  <!-- Logo area (optional) -->
  <circle cx="600" cy="440" r="40" fill="#58a6ff" opacity="0.3"/>
</svg>
```

**Dark theme with dot pattern:**

```xml
<svg viewBox="0 0 1280 640" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="10" cy="10" r="1" fill="rgba(255,255,255,0.1)"/>
    </pattern>
  </defs>
  <rect width="1280" height="640" fill="#0d1117"/>
  <rect width="1280" height="640" fill="url(#dots)"/>
  <text x="640" y="300" text-anchor="middle" font-family="monospace"
        font-size="64" font-weight="700" fill="#58a6ff">Project Name</text>
  <text x="640" y="360" text-anchor="middle" font-family="sans-serif"
        font-size="24" fill="#8b949e">Your awesome tagline here</text>
</svg>
```

**Wave decoration:**

```xml
<svg viewBox="0 0 1280 640" xmlns="http://www.w3.org/2000/svg">
  <rect width="1280" height="640" fill="#1e293b"/>
  <path d="M0 500 Q320 440 640 480 T1280 460 V640 H0Z" fill="#6366f1" opacity="0.3"/>
  <path d="M0 520 Q320 480 640 500 T1280 490 V640 H0Z" fill="#6366f1" opacity="0.2"/>
  <text x="640" y="280" text-anchor="middle" font-family="sans-serif"
        font-size="64" font-weight="700" fill="white">Project Name</text>
</svg>
```
