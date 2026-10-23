import { z } from "zod";
import { defineMethod } from "./define.ts";
import { HealthEvent } from "./health.ts";
import { Cursor } from "./frames.ts";

/** Browser sessions only, the models/MCP precedent: a token must not read the daemon's failure surface (spec §4). */
export const healthMethods = {
  "ops.events.list": defineMethod({
    name: "ops.events.list",
    permission: "pi:admin",
    idempotent: true,
    params: z
      .object({
        before: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    result: z.object({ events: z.array(HealthEvent).max(200), hasMore: z.boolean() }).strict(),
    errors: [],
  }),
  "subscribe.ops": defineMethod({
    name: "subscribe.ops",
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
};
