import { describe, expect, it } from "vitest";
import { PTY_FRAME_BYTES, PTY_WINDOW_BYTES, PtyCommand, PtyReport } from "./pty-frames.ts";

const b64 = (bytes: number): string => Buffer.alloc(bytes, 1).toString("base64");

describe("pty frames", () => {
  it("output frames refuse more than 64 KiB raw", () => {
    expect(PtyReport.safeParse({ type: "pty_output", data: b64(PTY_FRAME_BYTES) }).success).toBe(true);
    expect(PtyReport.safeParse({ type: "pty_output", data: b64(PTY_FRAME_BYTES + 1) }).success).toBe(false);
    expect(PtyReport.safeParse({ type: "pty_output", data: "not base64!" }).success).toBe(false);
    expect(PtyCommand.safeParse({ type: "pty_input", data: b64(PTY_FRAME_BYTES + 1) }).success).toBe(false);
  });

  it("bounds the window, the size and the signals", () => {
    expect(PTY_WINDOW_BYTES).toBe(1024 * 1024);
    expect(PtyCommand.safeParse({ type: "pty_resize", cols: 2, rows: 200 }).success).toBe(true);
    expect(PtyCommand.safeParse({ type: "pty_resize", cols: 1, rows: 24 }).success).toBe(false);
    expect(PtyCommand.safeParse({ type: "pty_resize", cols: 80, rows: 201 }).success).toBe(false);
    expect(PtyCommand.safeParse({ type: "pty_signal", signal: "SIGHUP" }).success).toBe(true);
    expect(PtyCommand.safeParse({ type: "pty_signal", signal: "SIGTERM" }).success).toBe(false);
    expect(PtyCommand.safeParse({ type: "pty_ack", bytes: -1 }).success).toBe(false);
    expect(PtyReport.safeParse({ type: "pty_exit", code: null, signal: "SIGHUP" }).success).toBe(true);
    expect(PtyReport.safeParse({ type: "pty_exit", code: 0, signal: null, extra: 1 }).success).toBe(false);
  });
});
