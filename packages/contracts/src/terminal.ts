import { z } from "zod";
import { defineMethod } from "./define.ts";
import { FilePath } from "./files.ts";
import { Cursor } from "./frames.ts";

/** `listed`: 64 running (the highest `PAP_MAX_TERMINALS`) plus 8 exited (M8R65). */
export const TERMINAL_LIMITS = {
  listed: 72,
  cols: { min: 2, max: 500 },
  rows: { min: 2, max: 200 },
} as const;
export const TerminalId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
/** A client's id for one create: a repeat returns the same terminal (M8R64). */
export const TerminalRequestId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const Cols = z.number().int().min(TERMINAL_LIMITS.cols.min).max(TERMINAL_LIMITS.cols.max);
const Rows = z.number().int().min(TERMINAL_LIMITS.rows.min).max(TERMINAL_LIMITS.rows.max);
const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StreamId = z.number().int().min(1).max(0xffff_ffff);

export const TerminalView = z.object({
  id: TerminalId,
  cwd: FilePath,
  sessionId: z.string().min(1).max(128).nullable(),
  cols: Cols,
  rows: Rows,
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  createdAt: z.number().int().min(0).max(8.64e15),
});
export type TerminalView = z.infer<typeof TerminalView>;

export const TerminalStreamEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), terminals: z.array(TerminalView).max(TERMINAL_LIMITS.listed) }),
  z.object({ kind: z.literal("terminal"), terminal: TerminalView }),
  z.object({ kind: z.literal("closed"), id: TerminalId }),
]);
export type TerminalStreamEvent = z.infer<typeof TerminalStreamEvent>;

/** The `exit` frame's payload. */
export const TerminalExit = z.object({
  code: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
});

const Ok = z.object({ ok: z.literal(true) });

export const terminalMethods = {
  "subscribe.terminal": defineMethod({
    name: "subscribe.terminal",
    permission: "terminal:read",
    idempotent: true,
    params: z.object({ after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: [],
  }),
  "terminal.create": defineMethod({
    name: "terminal.create",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({
      requestId: TerminalRequestId,
      cwd: FilePath,
      cols: Cols,
      rows: Rows,
      sessionId: z.string().min(1).max(128).optional(),
    }),
    result: z.object({ terminalId: TerminalId }),
    errors: ["not_found", "capacity", "terminal_unavailable"],
  }),
  "terminal.attach": defineMethod({
    name: "terminal.attach",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ terminalId: TerminalId, after: Offset.optional() }),
    result: z.object({
      streamId: StreamId,
      start: Offset,
      end: Offset,
      cols: Cols,
      rows: Rows,
      status: z.enum(["running", "exited"]),
    }),
    errors: ["not_found", "capacity"],
  }),
  "terminal.detach": defineMethod({
    name: "terminal.detach",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ streamId: StreamId }),
    result: Ok,
    errors: [],
  }),
  "terminal.resize": defineMethod({
    name: "terminal.resize",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ terminalId: TerminalId, cols: Cols, rows: Rows }),
    result: Ok,
    errors: ["not_found"],
  }),
  "terminal.close": defineMethod({
    name: "terminal.close",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ terminalId: TerminalId }),
    result: Ok,
    errors: [],
  }),
} as const;
