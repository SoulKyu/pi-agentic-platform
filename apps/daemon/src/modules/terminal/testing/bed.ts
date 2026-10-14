import { vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { createTerminal, type Terminal, type TerminalState } from "../index.ts";
import { createFakeConnection } from "./fake-stream.ts";
import { createFakePty } from "./fake-pty.ts";

/** One terminal over a fake PTY, a fake clock and any number of fake connections. */
export function makeBed(options: { withScope?: boolean } = {}) {
  const clock = createFakeClock();
  const pty = createFakePty(4242, clock);
  const { logger, lines } = captureLogger();
  const kill = vi.fn<(target: unknown) => Promise<void>>(async () => {
    pty.exit(null, "SIGHUP");
  });
  const reap = vi.fn<(exit: unknown) => Promise<{ oomKilled: boolean }>>(async () => ({ oomKilled: false }));
  const changes: TerminalState[] = [];
  const calls = { exited: 0, closed: 0 };
  const terminal: Terminal = createTerminal({
    id: "t1",
    ownerId: "u1",
    cwd: "/work",
    sessionId: null,
    cols: 80,
    rows: 24,
    pty,
    scope: options.withScope ? { reap } : null,
    clock,
    logger,
    kill,
    alive: () => pty.alive,
    changed: (view) => void changes.push(view),
    exited: () => void calls.exited++,
    closed: () => void calls.closed++,
  });
  const connect = (connectionId: string, after?: number) => {
    const connection = createFakeConnection();
    const info = terminal.attach(connectionId, (sink) => connection.open(sink), after);
    return { connection, info, stream: connection.last() };
  };
  return { clock, pty, terminal, kill, reap, changes, calls, lines, connect };
}
