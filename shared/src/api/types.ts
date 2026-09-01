/**
 * Wire-envelope and family-group types both apps must agree on.
 *
 * Every response of this API travels in the same `{ data, error }` envelope, and
 * the family endpoints answer the Extension and the PWA with the same records —
 * so a divergent copy of these declarations on one end is a contract break, not a
 * local style choice. They used to be written once per app
 * (`extension/src/api/types.ts` and `pwa/src/api/client.ts`); both now re-export
 * from here, so existing importers are unaffected.
 *
 * Types only — a declared `string` is what the backend CLAIMS, not what it sent.
 * The endpoint is user-configurable (BYO / a sync code's `@host`), so the runtime
 * checks live at each app's API boundary (`./memberValidation`, `./safeText`).
 */

/**
 * The project's Boolean Convention (AGENTS.md): every boolean-like field that
 * travels on the wire or into KV is this enum — never `boolean`, never a raw
 * `0` / `1` literal. `true === 1` is `false` under strict equality, so a
 * `boolean` on one end and a number on the other is a silent cross-platform bug
 * between Extension, PWA and Worker.
 *
 * Previously declared separately in `extension/src/api/types.ts` and
 * `pwa/src/api/client.ts`; single-sourced here so the two enums cannot drift.
 */
export enum BoolFlag {
  FALSE = 0,
  TRUE = 1,
}

/** The `error` half of the envelope, as it travels on the wire. */
export interface ApiErrorPayload {
  code: string;
  message: string;
  /** Seconds to wait before retrying, present on rate-limit (429) responses. */
  retryAfter?: number;
}

export interface ApiResponse<T> {
  data?: T;
  error?: ApiErrorPayload;
}

export interface FamilyMember {
  userId: string;
  displayName: string;
  /** Optional for backward compat with old API responses; treat missing/undefined as TRUE. */
  canLend?: BoolFlag;
  /** Readmoo display name for lending automation (v1.1.0). */
  readmooName?: string;
}

export interface FamilyGroup {
  familyId: string;
  ownerId: string;
  members: FamilyMember[];
  maxMembers: number;
  createdAt: string;
  apiEndpoint?: string | null;
  /** Auth token issued alongside family create/join responses. */
  authToken?: string;
  /** Unix millis when authToken expires. */
  expiresAt?: number;
}
