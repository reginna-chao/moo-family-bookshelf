import { z } from "@hono/zod-openapi";

export function jsonRes(description: string) {
  return {
    content: { "application/json": { schema: z.any() } },
    description,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const defaultHook = (result: { success: boolean }, c: any) => {
  if (!result.success) {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }
};
