# MooFamily Bookshelf (Chrome Extension)

## Introduction

This extension injects a "Family Bookshelf" Dialog into Readmoo (readmoo.com) web pages, allowing members under the same Readmoo family account to browse books that others have chosen to share. All sharing is opt-in — no books are shared by default.

## Why host_permissions Are Required

```
"host_permissions": [
  "https://next.readmoo.com/*",
  "https://read.readmoo.com/*"
]
```

These permissions are scoped to Readmoo's bookshelf web app hosts (`next.readmoo.com`, and the legacy `read.readmoo.com`) and are used exclusively for the following purposes:

- Injecting the Family Bookshelf Dialog UI into Readmoo pages so users can browse shared books without leaving the site
- Scraping the current logged-in user's book list from the Readmoo page DOM (only publicly visible book information such as title, cover, and author is read; no account credentials are read, stored, or transmitted)
- Confirming which Readmoo account is logged in by reading Readmoo's own login cookie `ReadmooNext.email`, which holds the account's email. The email is hashed locally (app-specific prefix + SHA-256) and compared with the stored anonymous user ID; it is never stored or transmitted. This is the only cookie the extension reads (on the store book pages below as well, under the same rule), and it never sets or modifies any cookie
- Maintaining a message bridge between the Content Script and the background Service Worker for syncing personal sharing settings and family bookshelf queries

### Optional: Readmoo store book pages

```
"permissions": ["storage", "scripting"],
"optional_host_permissions": ["https://readmoo.com/book/*"]
```

The store-page chip ("which family member has shared this book") is off by default. The optional host permission `https://readmoo.com/book/*` is requested only when the user turns the feature on in the extension's options page (opened from the toolbar icon), and is used exclusively to:

- Read the book id from the store page's URL and show the sharing family members' names below the book title
- Read the same `ReadmooNext.email` login cookie, under the same rule as above, so the names appear only when the logged-in account is the one this extension was set up with

The page makes no network request: the names come from a list kept in local extension storage, built when the user opens the Family Bookshelf. The `scripting` permission registers that store-page script at runtime, only while the feature is on and the permission granted.

## Privacy Statement

This extension does not collect any personally identifiable information (PII). All data is transmitted over TLS and protected by auth tokens for access control. No account registration, email collection, or tracking is involved.
