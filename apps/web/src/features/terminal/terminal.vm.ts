import type { TerminalView } from "@pap/contracts";

export type TerminalPhase = "attaching" | "live" | "offline" | "busy" | "exited" | "gone";

export interface TerminalPaneView {
  readonly phase: TerminalPhase;
  /** Three seconds in a waiting state: the pane adds a stage label (never a repainting spinner, DESIGN §7.3). */
  readonly slow: boolean;
  readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
  /** Busy and out of automatic retries: the pane offers "Try again". */
  readonly busyExhausted: boolean;
  /** "Close the terminal and stop what runs in it?" is on screen. */
  readonly confirmingClose: boolean;
  readonly closeFailed: boolean;
  /** Live, the replay written and a screen set: what is typed now reaches the shell and nothing answers a replayed query. */
  readonly typing: boolean;
}

export const INITIAL_VIEW: TerminalPaneView = {
  phase: "attaching",
  slow: false,
  exit: null,
  busyExhausted: false,
  confirmingClose: false,
  closeFailed: false,
  typing: false,
};

/** A size reported by the pane is sent at most this often (M8R80). */
export const RESIZE_MS = 100;
/** How long a waiting state lasts before the stage label shows. */
export const SLOW_MS = 3000;
/** Automatic attach retries when the server is full, then the pane waits for the owner. */
export const MAX_BUSY_ATTEMPTS = 5;

/** Wait before the nth automatic retry: 0.5 s, 1 s, 2 s, 4 s, 8 s. */
export const retryDelayMs = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);

export const runningCount = (terminals: readonly TerminalView[]): number =>
  terminals.reduce((count, one) => count + (one.status === "running" ? 1 : 0), 0);

/** What xterm's `onBinary` gives (one code point per byte, 0-255) as the bytes it stands for. */
export function bytesOfBinary(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index++) bytes[index] = data.charCodeAt(index) & 0xff;
  return bytes;
}

/** A terminal that still runs asks before it is closed; one that ended does not. */
export const needsConfirmation = (phase: TerminalPhase): boolean => phase !== "exited" && phase !== "gone";
