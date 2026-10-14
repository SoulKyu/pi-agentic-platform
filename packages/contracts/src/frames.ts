import { z } from "zod";
import { ERROR_CODES } from "./errors.ts";

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const CAPABILITIES = ["rpc", "subscribe", "terminal"] as const;

export const Cursor = z.object({ epoch: z.string().min(1).max(64), seq: z.number().int().nonnegative() });
export type Cursor = z.infer<typeof Cursor>;

export const RequestFrame = z.object({
  id: z.number().int().nonnegative(),
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
  commandId: z.string().min(8).max(128).optional(),
});
export type RequestFrame = z.infer<typeof RequestFrame>;

export const ResponseFrame = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.object({
      code: z.enum(ERROR_CODES),
      /** Only on `capacity`: workers in use and the cap. */
      workers: z
        .object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
        .optional(),
    }),
  }),
]);
export type ResponseFrame = z.infer<typeof ResponseFrame>;

export const EventFrame = z.object({
  sub: z.string().min(1),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: z.unknown(),
});
export type EventFrame = z.infer<typeof EventFrame>;

export const HelloFrame = z.object({
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
  serverVersion: z.string(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;
