---
name: security-audit
description: >
  Scan the repository for security risks across 7 dimensions: secrets leakage, dependency vulnerabilities,
  code-level OWASP issues, Chrome Extension permissions, hashing & auth token handling, API security, and pre-publish readiness.
  Read-only analysis; does NOT modify code.
  TRIGGER when: user explicitly invokes /security-audit, or asks to check for security issues, secrets, or pre-publish safety.
  DO NOT TRIGGER when: user wants code written, tests added, or code reviewed for non-security concerns.
argument-hint: "[full | secrets | deps | code | extension | crypto | api | publish]"
allowed-tools: Read, Grep, Glob, Bash(pnpm audit*), Bash(git log*), Bash(git diff*), Bash(git show*), Bash(git ls-files*), Bash(cat *manifest*), Bash(ls*), Bash(find*), Agent
model: opus
---

# Security Audit

## Role

Scan the entire repository for security risks. Read-only — never modify code, only report findings.

## Invocation

```
/security-audit [scope]
```

**Scope** (optional, defaults to `full`):

| Scope       | Description                                   |
| ----------- | --------------------------------------------- |
| `full`      | Run all 7 dimensions                          |
| `secrets`   | Dimension 1 only — secrets & credentials      |
| `deps`      | Dimension 2 only — dependency vulnerabilities |
| `code`      | Dimension 3 only — code-level OWASP issues    |
| `extension` | Dimension 4 only — Chrome Extension security  |
| `crypto`    | Dimension 5 only — Hashing implementation     |
| `api`       | Dimension 6 only — API & Worker security      |
| `publish`   | Dimension 7 only — pre-publish readiness      |

## Audit Dimensions

### Dimension 1: Secrets & Credentials Leakage

Scan for secrets that must never be committed to version control.

**Checks:**

- Hardcoded API keys, tokens, passwords, private keys in source code
- `.env`, `.dev.vars`, or credential files tracked by git (`git ls-files`)
- Private keys or certificates (`.pem`, `.key`, `.p12`, `.pfx`, `.cert`)
- PEM markers (`-----BEGIN`) in any tracked file
- Secrets in CI/CD workflows not using `${{ secrets.* }}` pattern
- Cloudflare account IDs, zone IDs, or real KV namespace IDs in config files
- Hardcoded URLs containing credentials (e.g., `https://user:pass@`)
- Sensitive values in `package.json`, `wrangler.toml`, or any JSON/YAML config

**Search patterns:**

```
API_KEY, SECRET, TOKEN, PASSWORD, PRIVATE_KEY, CREDENTIAL,
BEARER, AUTHORIZATION, api_key, secret_key, access_token,
database_url, connection_string, -----BEGIN
```

### Dimension 2: Dependency Vulnerabilities

Check for known vulnerabilities in project dependencies.

**Checks:**

- Run `pnpm audit` in `extension/` and `worker/` directories
- Flag `critical` and `high` severity vulnerabilities
- Check for outdated packages with known CVEs
- Verify lock files (`pnpm-lock.yaml`) are present and committed
- Check for suspicious or typo-squatted package names

### Dimension 3: Code-Level Security (OWASP)

Scan source code for common vulnerability patterns.

**Checks:**

- **Injection**: `eval()`, `Function()`, `innerHTML`, `dangerouslySetInnerHTML`, `document.write()`
- **XSS**: Unsanitized user input rendered in DOM, template literal injection in HTML
- **Prototype pollution**: `Object.assign` with untrusted input, `__proto__` access
- **Regex DoS**: Complex regex patterns vulnerable to ReDoS
- **Insecure randomness**: `Math.random()` used for security-sensitive operations (should use `crypto.getRandomValues`)
- **Information disclosure**: `console.log` or `console.error` leaking sensitive data in production code
- **Unsafe deserialization**: `JSON.parse` on untrusted input without validation

### Dimension 4: Chrome Extension Security

Review extension-specific security concerns.

**Checks:**

- `manifest.json` permissions: are they minimal and justified?
- Content Security Policy (CSP): is it defined and restrictive?
- `host_permissions`: overly broad patterns (e.g., `<all_urls>`, `*://*/*`)
- Content Script injection scope: limited to intended domains only?
- `web_accessible_resources`: only exposing what's necessary?
- Message passing: `chrome.runtime.onMessageExternal` properly validated?
- Storage: sensitive data in `chrome.storage.local` (not `chrome.storage.sync` which syncs to Google)
- No `executeScript` with dynamic code strings
- No remote code loading (`fetch` + `eval`, dynamic `import()` from external URLs)

### Dimension 5: Hashing & Auth Token Review

Verify the hashing module and auth token handling follow best practices.

**Checks:**

- Hashing: using SHA-256 via `crypto.subtle` for deriveUserId? Salt applied correctly?
- Auth tokens: never logged, never in error messages, never in URL params
- Token validation: constant-time comparison for security-sensitive values (tokens, hashes)
- Web Crypto API usage: using `crypto.subtle` (not a JS polyfill) for all hash operations
- Error handling: errors don't leak token material or sensitive data in error messages

### Dimension 6: API & Worker Security

Review backend API for security vulnerabilities. Go beyond "does it exist" — check **implementation quality**.

**6A. Authentication — verify every protected endpoint is guarded:**

- All non-public endpoints require a valid auth token (Bearer header).
- **Authorization bypass patterns**: look for `if (userId) { /* check */ }` instead of `if (!userId) return 401`. A conditional guard that silently skips when null is a regression hazard — any change to public route list could expose data.
- Verify the public route list (`isPublicRoute`) is minimal and cannot be expanded without review.

**6B. Authorization — verify identity source and access control:**

- **IDOR (Insecure Direct Object Reference)**: when a handler receives a user ID in both the request body AND the auth token, the authenticated identity (`callerUserId`) must be the sole source of truth. Body-supplied identity fields should be ignored or validated against the token. Flag any `body.userId` used for permission checks instead of the authenticated caller.
- Family membership verified before returning any family data.
- Owner-only actions (remove member, transfer ownership) check `callerUserId === record.ownerId`.

**6C. Input validation:**

- All user inputs validated and sanitized at handler level.
- KV key injection: user-controlled values used directly in KV key construction without sanitization?
- **Request body size**: middleware enforces a max body size. Check if the limit can be bypassed (e.g., by omitting `Content-Length` header).

**6D. Rate limiting — check implementation quality, not just existence:**

- Implemented on sensitive endpoints (create family, join family).
- **IP source trustworthiness**: rate limiter must use a non-spoofable IP header. `cf-connecting-ip` (Cloudflare edge) is safe; `x-forwarded-for` is client-controllable and must NOT be the sole/primary source. Check the fallback chain.
- **Counter atomicity**: KV read-then-write is not atomic. Document whether concurrent requests can exceed the configured limit and assess impact.
- **Tier separation**: public routes (unauthenticated) should have stricter limits than authenticated routes. Verify separate counters (different KV key prefixes) so exhausting one tier doesn't affect the other.

**6E. CORS — check origin validation depth:**

- Not `Access-Control-Allow-Origin: *` in production.
- **Origin allowlist review**: list every allowed origin pattern and verify each is necessary.
- **Localhost in production**: `http://localhost` must be gated behind a dev-mode flag, not unconditionally allowed. A locally-running malicious page can exploit this.
- **Subdomain spoofing**: if using regex for subdomain matching (e.g., `*.readmoo.com`), verify the regex is anchored (`^...$`) and uses restrictive character classes. Test against payloads like `readmoo.com.evil.com`.
- **Regex ReDoS**: origin-matching regex must not contain nested quantifiers or ambiguous alternations.
- **Preview/staging origins**: if using Cloudflare Pages or similar, preview deploy URLs (e.g., `abc123.project.pages.dev`) should be explicitly allowed or denied.

**6F. Response security:**

- Error messages: no internal details leaked (stack traces, KV keys, etc.).
- HTTP headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-XSS-Protection: 0` set on all responses.
- Data access: Worker stores plaintext JSON; verify auth tokens are validated before returning data.

**6G. Enumeration & abuse:**

- Family IDs or user IDs not easily enumerable.
- Public endpoints (create/join) cannot be used to spam KV with garbage data without rate limiting.

### Dimension 7: Pre-Publish Readiness

Verify the repository is safe to make public.

**Checks:**

- `.gitignore` covers: `.env`, `.dev.vars`, `node_modules/`, `.wrangler/`, build output, OS files, IDE config
- No internal/company references in code, comments, docs, or commit messages
- No personal information (real names, emails, phone numbers) in source files
- No internal URLs, staging endpoints, or private service addresses
- No TODO/FIXME comments containing sensitive context
- `LICENSE` file present and appropriate
- `wrangler.toml` uses placeholder values (not real account/zone IDs)
- CI/CD uses `${{ secrets.* }}` for all credentials

## Output Format

### Per-Finding

```
[CRITICAL|WARNING|INFO] Dimension {N}: {dimension name}
Location: {file}:{line} (or "repo-wide" for broad checks)
Issue: {description}
Risk: {what could go wrong if exploited}
Remediation: {how to fix}
```

### Severity Levels

| Level        | Meaning                                                                   | Action          |
| ------------ | ------------------------------------------------------------------------- | --------------- |
| **CRITICAL** | Exploitable vulnerability or secret exposure. Must fix before publishing. | Block release   |
| **WARNING**  | Potential risk or bad practice. Should fix.                               | Fix recommended |
| **INFO**     | Observation or minor improvement. Nice to have.                           | Optional        |

## Summary Report

After all dimensions are checked, output a summary table:

```
## Security Audit Summary

| Dimension | Status | Critical | Warning | Info |
|-----------|--------|----------|---------|------|
| 1. Secrets & Credentials | ✅ PASS / ❌ FAIL | 0 | 0 | 0 |
| 2. Dependency Vulnerabilities | ... | ... | ... | ... |
| 3. Code-Level OWASP | ... | ... | ... | ... |
| 4. Chrome Extension Security | ... | ... | ... | ... |
| 5. Hashing & Auth Token | ... | ... | ... | ... |
| 6. API & Worker Security | ... | ... | ... | ... |
| 7. Pre-Publish Readiness | ... | ... | ... | ... |

**Overall Verdict: PASS / PASS WITH WARNINGS / FAIL**
```

## Verdict

- **PASS**: No critical or warning findings. Safe to publish.
- **PASS WITH WARNINGS**: No critical findings but warnings exist. Review recommended.
- **FAIL**: Critical findings detected. Must fix before publishing.

## Rules

- Never modify any code — this is a read-only audit.
- Always run all checks for the requested scope, even if early findings look clean.
- When uncertain whether something is a real risk, report it as INFO rather than suppressing.
- For Dimension 2 (deps), if `pnpm audit` is not available, note it as a limitation rather than skipping.
- Cross-reference findings across dimensions (e.g., a hardcoded key in crypto code is both Dim 1 and Dim 5).
