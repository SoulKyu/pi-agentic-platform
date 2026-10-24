import { z } from "zod";

/** Unacknowledged output the pty may have in flight before it pauses its child (the daemon acknowledges what the browser took). */
export const PTY_WINDOW_BYTES = 1024 * 1024;
export const PTY_FRAME_BYTES = 64 * 1024;
const PTY_FRAME_B64 = Math.ceil(PTY_FRAME_BYTES / 3) * 4;

const Base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const rawBytes = (b64: string): number =>
  (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
const Data = z
  .string()
  .max(PTY_FRAME_B64)
  .regex(Base64)
  .refine((b64) => rawBytes(b64) <= PTY_FRAME_BYTES, "at most 64 KiB raw");
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Daemon to the box's pty. */
export const PtyCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pty_input"), data: Data }).strict(),
  z
    .object({
      type: z.literal("pty_resize"),
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(2).max(200),
    })
    .strict(),
  z.object({ type: z.literal("pty_ack"), bytes: Count }).strict(),
  z.object({ type: z.literal("pty_signal"), signal: z.enum(["SIGHUP", "SIGKILL"]) }).strict(),
]);
export type PtyCommand = z.infer<typeof PtyCommand>;

/** The box's pty to the daemon. */
export const PtyReport = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pty_output"), data: Data }).strict(),
  z
    .object({
      type: z.literal("pty_exit"),
      code: z.number().int().nullable(),
      signal: z
        .string()
        .regex(/^SIG[A-Z0-9]{1,13}$/)
        .nullable(),
    })
    .strict(),
]);
export type PtyReport = z.infer<typeof PtyReport>;
