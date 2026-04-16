# MooFamily Bookshelf (Chrome Extension)

## Introduction

This extension injects a "Family Bookshelf" Dialog into Readmoo (readmoo.com) web pages, allowing members under the same Readmoo family account to browse books that others have chosen to share. All sharing is opt-in — no books are shared by default.

## Why host_permissions Are Required

```
"host_permissions": ["https://read.readmoo.com/*"]
```

This permission is scoped to `read.readmoo.com` and is used exclusively for the following purposes:

- Injecting the Family Bookshelf Dialog UI into Readmoo pages so users can browse shared books without leaving the site
- Scraping the current logged-in user's book list from the Readmoo page DOM (only publicly visible book information such as title, cover, and author is read; no account credentials or cookies are read, stored, or transmitted)
- Maintaining a message bridge between the Content Script and the background Service Worker for syncing personal sharing settings and family bookshelf queries

## Privacy Statement

This extension does not collect any personally identifiable information (PII). All data is transmitted over TLS and protected by auth tokens for access control. No account registration, email collection, or tracking is involved.
