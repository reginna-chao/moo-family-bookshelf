import { z } from "@hono/zod-openapi";

export const UserIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const FamilyIdSchema = z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
export const RequestIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const ShareTokenSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const PinSchema = z.string().regex(/^\d{6,12}$/);

export const UserIdParam = z.object({ id: z.string() });
export const FamilyIdParam = z.object({ id: z.string() });
export const ShelfIdParam = z.object({ id: z.string(), shelfId: z.string() });
export const RequestIdParamObj = z.object({ requestId: z.string() });
export const ShareTokenParam = z.object({ shareToken: z.string() });
