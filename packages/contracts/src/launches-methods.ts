import { z } from "zod";
import { BoxRef } from "./box-ref.ts";
import { defineMethod } from "./define.ts";
import { Cursor } from "./frames.ts";
import { LAUNCH_LIMITS } from "./launches.ts";

/** The caller's own live launches and the Pi helper counts, like `subscribe.shell`: the key is a local name. */
export const launchesMethods = {
  "subscribe.launches": defineMethod({
    name: "subscribe.launches",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
  /** "Show the log": the last build lines (or the guest's boot lines) of a box the caller owns. Another owner's box is `not_found`. */
  "launches.log": defineMethod({
    name: "launches.log",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ box: BoxRef }).strict(),
    result: z
      .object({ lines: z.array(z.string().max(LAUNCH_LIMITS.lineChars)).max(LAUNCH_LIMITS.logLines) })
      .strict(),
    errors: ["not_found"],
  }),
  /** "Stop" on a launch's ask: ends the caller's own live launch as `stopped` and stops its box. Another owner's, an unknown or an ended id is `not_found`; the box kind picks `agents:operate` or `sessions:operate`. */
  "launches.stop": defineMethod({
    name: "launches.stop",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ id: z.string().min(1).max(64) }).strict(),
    result: z.object({}).strict(),
    errors: ["not_found", "forbidden"],
  }),
};
