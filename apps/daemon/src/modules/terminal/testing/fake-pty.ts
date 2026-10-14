import type { Clock } from "../../../kernel/clock.ts";
import type { PtyProcess } from "../../../kernel/pty/spawn.ts";

/** A `PtyProcess` a test drives by hand: it keeps what was written, resized, paused and resumed. */
export interface FakePty extends PtyProcess {
  readonly writes: Uint8Array[];
  readonly resizes: Array<{ cols: number; rows: number }>;
  /** Every pause / resume call, in order. */
  readonly flow: Array<"pause" | "resume">;
  readonly paused: boolean;
  /** False once the child died (what a `/proc` start-time check would say). */
  readonly alive: boolean;
  /** The shell wrote this. While paused it is held, as the kernel holds it, and delivered on resume. */
  emit(data: string | Uint8Array): void;
  /**
   * The child died. Like node-pty 1.1.0: when the PTY is paused, the socket never sees EOF, so after 200 ms it is
   * destroyed (held output lost) and only then `exit` is reported; when not paused, `exit` is reported at once.
   * Needs the clock for the paused case.
   */
  exit(code: number | null, signal?: string | null): void;
}

export const NODE_PTY_PAUSED_EXIT_MS = 200;

export function createFakePty(pid = 4242, clock?: Clock): FakePty {
  let listener: (chunk: Buffer) => void = () => {};
  let finish: (exit: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    finish = resolve;
  });
  const flow: Array<"pause" | "resume"> = [];
  let paused = false;
  let alive = true;
  let held: Buffer[] = [];
  let report: (() => void) | null = null;
  return {
    pid,
    start: "1",
    exited,
    writes: [],
    resizes: [],
    flow,
    get paused() {
      return paused;
    },
    get alive() {
      return alive;
    },
    onData(next) {
      listener = next;
    },
    write(data) {
      this.writes.push(new Uint8Array(data));
    },
    resize(cols, rows) {
      this.resizes.push({ cols, rows });
    },
    pause() {
      flow.push("pause");
      paused = true;
    },
    resume() {
      flow.push("resume");
      paused = false;
      const pending = held;
      held = [];
      for (const chunk of pending) listener(chunk);
      report?.();
    },
    emit(data) {
      const chunk = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      if (paused) held.push(chunk);
      else listener(chunk);
    },
    exit(code, signal = null) {
      alive = false;
      const done = (): void => finish({ code, signal });
      if (!paused || !clock) return done();
      report = () => {
        report = null;
        done();
      };
      clock.setTimeout(() => {
        if (!report) return;
        held = []; // destroyed with the socket
        report();
      }, NODE_PTY_PAUSED_EXIT_MS);
    },
  };
}
