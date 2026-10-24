import { PTY_FRAME_BYTES } from "@pap/contracts";
import type { BoxPtyChannel } from "../../kernel/boxes.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { PTY_EXIT_WAIT_MS, PTY_HANGUP_GRACE_MS } from "../../kernel/pty/kill.ts";
import { clampSize, PTY_COLS, PTY_ROWS, type PtyProcess } from "../../kernel/pty/spawn.ts";
import type { RemoteShell } from "./registry.ts";

/** The guest is told what was taken once this much is unacknowledged (a smaller rest waits for the next output or a resume). */
export const ACK_EVERY_BYTES = PTY_FRAME_BYTES;

type Exit = { code: number | null; signal: string | null };

/**
 * A box terminal's shell as the terminal module sees any shell: the guest holds the pty, this end speaks `pty-frames.ts` on
 * the terminal's own connection. `pause` and `resume` are the window: output taken is acknowledged (cumulative bytes) unless
 * paused, and a resume acknowledges at once what was withheld, so the guest pauses its pty past `PTY_WINDOW_BYTES`. A lost
 * connection is an exit (the shell cannot outlive it: the guest kills its group). The kill is two signals and a wait on the
 * clock, never a host pid or a /proc walk.
 */
export function createRemoteShell(deps: {
  readonly projectId: string;
  readonly channel: BoxPtyChannel;
  readonly clock: Clock;
  readonly logger: Logger;
}): RemoteShell {
  const { channel, clock, logger } = deps;
  let received = 0;
  let acked = 0;
  let paused = false;
  let gone = false;
  let listener: ((chunk: Buffer) => void) | undefined;
  const early: Buffer[] = [];
  let settle: (exit: Exit) => void = () => {};
  const exited = new Promise<Exit>((resolve) => {
    settle = resolve;
  });

  const finish = (exit: Exit): void => {
    if (gone) return;
    gone = true;
    settle(exit);
    channel.close();
  };
  const ack = (force: boolean): void => {
    if (gone || received === acked) return;
    if (!force && received - acked < ACK_EVERY_BYTES) return;
    if (channel.send({ type: "pty_ack", bytes: received })) acked = received;
  };

  channel.onReport((report) => {
    if (gone) return;
    if (report.type === "pty_exit") return finish({ code: report.code, signal: report.signal });
    const chunk = Buffer.from(report.data, "base64");
    received += chunk.length;
    if (listener) listener(chunk);
    else early.push(chunk);
    if (!paused) ack(false);
  });
  void channel.closed.then(() => finish({ code: null, signal: null }));

  const pty: PtyProcess = {
    pid: 0,
    start: null,
    exited,
    onData(next) {
      listener = next;
      for (const chunk of early.splice(0)) next(chunk);
    },
    write(data) {
      for (let at = 0; at < data.byteLength; at += PTY_FRAME_BYTES) {
        const part = data.subarray(at, at + PTY_FRAME_BYTES);
        channel.send({ type: "pty_input", data: Buffer.from(part).toString("base64") });
      }
    },
    resize: (cols, rows) =>
      void channel.send({
        type: "pty_resize",
        cols: clampSize(cols, PTY_COLS),
        rows: clampSize(rows, PTY_ROWS),
      }),
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      ack(true);
    },
  };

  /** Resolves when the shell is gone or after `ms` on the clock, whichever comes first. */
  const goneWithin = async (ms: number): Promise<boolean> => {
    let timer: TimerHandle | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = clock.setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([exited.then(() => true as const), timeout]);
    if (timer) clock.clearTimeout(timer);
    return result;
  };

  return {
    projectId: deps.projectId,
    pty,
    alive: () => !gone,
    async kill() {
      if (gone) return;
      channel.send({ type: "pty_signal", signal: "SIGHUP" });
      if (await goneWithin(PTY_HANGUP_GRACE_MS)) return;
      channel.send({ type: "pty_signal", signal: "SIGKILL" });
      if (await goneWithin(PTY_EXIT_WAIT_MS)) return;
      logger.warn("pty_kill_timeout", { projectId: deps.projectId });
      finish({ code: null, signal: "SIGKILL" });
    },
  };
}
