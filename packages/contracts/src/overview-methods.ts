import { z } from "zod";
import { defineMethod } from "./define.ts";
import { Cursor } from "./frames.ts";
import { OverviewSnapshot } from "./overview.ts";

/** The caller's own view (R1, M14): an owner and a member both read only their own boxes; the owner adds content-free usage lines of the members. */
export const overviewMethods = {
  "overview.get": defineMethod({
    name: "overview.get",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({}).strict(),
    result: OverviewSnapshot,
    errors: [],
  }),
  "subscribe.overview": defineMethod({
    name: "subscribe.overview",
    permission: "sessions:read",
    idempotent: true,
    // No key: the stream is the caller's own, like `usage`.
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
} as const;
