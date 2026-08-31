/**
 * Coerce a backend-supplied error message into something React can safely
 * render — the single copy shared by Extension and PWA.
 *
 * Threat model. Both API clients read the `{ data, error }` envelope with a
 * bare cast (`(await response.json()) as ApiResponse<T>`), so every field the
 * types call `string` is really `unknown` at runtime. The backend is
 * self-hostable, and a sync code's `@host` lets whoever wrote the invite pick
 * it, so "the server sends what its types promise" is not an assumption this
 * code may make. An envelope like `{"error":{"code":"X","message":{"a":1}}}`
 * puts a plain object into React state; rendering it as a JSX child makes
 * React 19 throw "Objects are not valid as a React child", and neither app
 * mounts an ErrorBoundary — the Dialog / page goes white and stays white until
 * a reload. A non-string message must therefore degrade to local copy instead
 * of reaching the DOM. An empty string degrades too: a blank error is not a
 * report.
 *
 * Why this one belongs in `shared/` while the `rateLimitedEnvelopeMessage`
 * pair deliberately does not (see extension/src/dialog/verificationMessages.ts
 * — the two apps genuinely disagree on `retryAfter === 0`, so a single
 * implementation would silently reword one of them): this helper carries no
 * semantics to disagree about. It is type coercion; the fallback copy stays at
 * the call site, both apps must behave byte-identically, and drift is the only
 * failure mode here.
 *
 * Runtime-agnostic by construction — no globals at all.
 */
export function safeErrorText(message: unknown, fallback: string): string {
  return typeof message === "string" && message.length > 0 ? message : fallback;
}
