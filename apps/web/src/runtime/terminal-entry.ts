import type { TerminalSink } from "./terminal-types.ts";

export type SinkState = Parameters<TerminalSink["state"]>[0];

export interface Entry {
  readonly terminalId: string;
  readonly sink: TerminalSink;
  closed: boolean;
  gone: boolean;
  /** Detached by the hidden-page rule: attached again once the page is visible. */
  hiddenDetached: boolean;
  /** Bumped by every attach, drop, hidden detach and close: an attach answer from an older one is stale (R11). */
  gen: number;
  /** Bumped by every `reset` frame: a write from before it no longer says how far the screen got. */
  epoch: number;
  streamId: number | null;
  shown: SinkState | null;
  /** The offset up to which the sink finished writing; null until the first frame. */
  written: number | null;
  lastAcked: number;
  unacked: number;
  inputSeq: number;
  /** The last size the pane asked for (clamped): sent again whenever a stream is attached. */
  size: { cols: number; rows: number } | null;
  writing: Set<Promise<void>>;
  hideTimer: number | null;
}

/** One `terminal.attach` in flight for a terminal on one socket (MC31). */
export interface Pending {
  readonly link: number;
  readonly after: number | null;
}

export const clamp = (value: number, limits: { min: number; max: number }): number =>
  Math.min(limits.max, Math.max(limits.min, Math.round(value)));

export const isConnectionLoss = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "offline" || code === "connection_lost";
};

export function safeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
