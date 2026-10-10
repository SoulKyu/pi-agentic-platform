import { z } from "zod";

export const STREAMS = ["session"] as const;
export type StreamName = (typeof STREAMS)[number];

export const SessionStatus = z.enum(["cold", "starting", "idle", "running"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Dialog = z.object({
  id: z.string().min(1).max(128),
  method: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string().max(4096),
  message: z.string().max(65_536).optional(),
  options: z.array(z.string().max(4096)).max(100).optional(),
  placeholder: z.string().max(4096).optional(),
  prefill: z.string().max(1_000_000).optional(),
  timeout: z.number().int().positive().optional(),
});
export type Dialog = z.infer<typeof Dialog>;

export const DialogResponse = z.union([
  z.object({ confirmed: z.boolean() }),
  z.object({ value: z.string().max(1_000_000) }),
  z.object({ cancelled: z.literal(true) }),
]);
export type DialogResponse = z.infer<typeof DialogResponse>;

export const PiEvent = z.looseObject({ type: z.string() });
export type PiEvent = z.infer<typeof PiEvent>;

export const SessionStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    status: SessionStatus,
    messages: z.array(z.unknown()),
    dialogs: z.array(Dialog),
  }),
  z.object({ kind: z.literal("status"), status: SessionStatus, cause: z.string().optional() }),
  z.object({ kind: z.literal("pi"), event: PiEvent }),
  z.object({ kind: z.literal("dialog_open"), dialog: Dialog }),
  z.object({ kind: z.literal("dialog_closed"), id: z.string() }),
  z.object({ kind: z.literal("notice"), level: z.enum(["info", "warning", "error"]), text: z.string() }),
]);
export type SessionStreamEvent = z.infer<typeof SessionStreamEvent>;

export const SessionSummary = z.object({
  id: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;
