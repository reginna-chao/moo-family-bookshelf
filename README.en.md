# MooFamily Bookshelf

[繁體中文](README.md)

Easily browse books shared by family members on your Readmoo family account.

<img src="assets/brand/og-image.svg" alt="MooFamily Bookshelf - Share your bookshelf">

## Features

- **Family Bookshelf** — See your family's shared books at a glance, no account sharing needed
- **Borrow between members** — Request a family member's shared book; the owner approves with one click and the Readmoo lending flow runs automatically
- **You decide what to share** — All books are private by default; only books you manually enable will appear on the family bookshelf
- **Data security** — All data is transmitted over TLS and protected by auth tokens for access control
- **Settings persist across families** — Leaving or switching families won't reset your sharing preferences
- **Mobile friendly** — Browse the family bookshelf on your phone via the mobile web app

## Installation

### Chrome Web Store (Recommended)

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/ogclfjfjdiminibemhbckobeapnohjnk?utm_source=github)

<details>

<summary>Manual Installation</summary>

1. [Download the latest release](https://github.com/reginna-chao/moo-family-bookshelf/releases) (`moo-family-bookshelf-chrome-vX.X.X.zip`) and extract it
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extracted folder
5. Done! Go to any Readmoo page and you'll see the "Family Bookshelf" button

</details>

### Firefox (Desktop / Android™)

Also available on Firefox Desktop and Firefox for Android™.

[Install from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/moofamily-bookshelf/)

<details>

<summary>Manual Installation (Firefox)</summary>

1. Download `moo-family-bookshelf-firefox-vX.X.X-direct-install.xpi` from [Releases](https://github.com/reginna-chao/moo-family-bookshelf/releases)
2. Open Firefox and navigate to `about:addons`
3. Click the gear icon in the top right → "Install Add-on From File…"
4. Select the downloaded `.xpi` and confirm the install
5. Done! This is a permanent (signed) install that auto-updates via `updates.json`

</details>

## Usage

1. **Create a family** — Click "Family Bookshelf" on any Readmoo page, create a family, and get a sync code
2. **Invite family members** — Share the sync code with your family; they enter it to join
3. **Choose books to share** — In "Personal Shelf", toggle each book on or off, then save to sync
4. **Browse the family bookshelf** — See all shared books from every family member in "Family Bookshelf"

Mobile users can browse the family bookshelf via the mobile web app (we recommend syncing from the desktop extension at least once first).

## Privacy

- **Secure access** — All data is transmitted over TLS and protected by auth tokens
- **No personal data collected** — No accounts, no email, no user tracking
- **Instant isolation on leave** — After leaving a family, other members can no longer see your books

See the full privacy policy at the [Privacy Policy page](https://reginna-chao.github.io/moo-family-bookshelf/privacy-policy.html).

## FAQ

See the [FAQ page](https://reginna-chao.github.io/moo-family-bookshelf/#faq).

---

## Developers

Want to contribute or self-host the backend? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

<a href="https://rcwork.bobaboba.me/" target="_blank"><img src="assets/boba-button.svg" alt="Give me a Boba!" height="40"></a>

## License

[MIT License](LICENSE)

This project is not officially affiliated with Readmoo.
