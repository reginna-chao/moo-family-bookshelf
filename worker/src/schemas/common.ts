import { z } from "@hono/zod-openapi";

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
// userIds are SHA-256 hex digests derived from the account email (see
// extension crypto/hash.ts). Enforce the strict 64-hex rule everywhere,
// matching the auth routes' Sha256HexSchema — there is no legitimate
// non-hex userId.
export const UserIdSchema = Sha256HexSchema;
export const FamilyIdSchema = z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
export const RequestIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const ShareTokenSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const PinSchema = z.string().regex(/^\d{6,12}$/);

export const UserIdParam = z.object({ id: z.string() });
export const FamilyIdParam = z.object({ id: z.string() });
export const ShelfIdParam = z.object({ id: z.string(), shelfId: z.string() });
export const RequestIdParamObj = z.object({ requestId: z.string() });
export const ShareTokenParam = z.object({ shareToken: z.string() });
