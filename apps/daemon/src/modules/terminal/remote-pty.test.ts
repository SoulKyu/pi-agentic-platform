import { PTY_FRAME_BYTES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { PTY_EXIT_WAIT_MS, PTY_HANGUP_GRACE_MS } from "../../kernel/pty/kill.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { ACK_EVERY_BYTES, createRemoteShell } from "./remote-pty.ts";
import { createFakeBoxPty } from "../../kernel/testing/fake-box-pty.ts";

function setup() {
  const fake = createFakeBoxPty();
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const shell = createRemoteShell({ projectId: "p1", channel: fake.channel, clock, logger });
  const chunks: Buffer[] = [];
  shell.pty.onData((chunk) => void chunks.push(chunk));
  const exits: unknown[] = [];
  void shell.pty.exited.then((exit) => exits.push(exit));
  return { fake, clock, shell, chunks, exits, lines };
}

const acks = (fake: ReturnType<typeof createFakeBoxPty>) =>
  fake.sent.filter((frame) => frame.type === "pty_ack");

describe("the remote pty", () => {
  it("maps pause and resume to acks", async () => {
    const { fake, shell, chunks } = setup();
    fake.output("a".repeat(ACK_EVERY_BYTES));
    expect(acks(fake)).toEqual([{ type: "pty_ack", bytes: ACK_EVERY_BYTES }]);
    shell.pty.pause();
    fake.output("b".repeat(1000));
    fake.output("c".repeat(ACK_EVERY_BYTES));
    expect(acks(fake)).toHaveLength(1); // withheld while paused: the guest's window fills
    shell.pty.resume();
    expect(acks(fake).at(-1)).toEqual({ type: "pty_ack", bytes: ACK_EVERY_BYTES * 2 + 1000 });
    expect(Buffer.concat(chunks).length).toBe(ACK_EVERY_BYTES * 2 + 1000);
  });

  it("splits input into frames of at most 64 KiB and clamps a resize", () => {
    const { fake, shell } = setup();
    shell.pty.write(new Uint8Array(PTY_FRAME_BYTES + 1));
    shell.pty.resize(9999, 1);
    const inputs = fake.sent.filter((frame) => frame.type === "pty_input");
    expect(inputs).toHaveLength(2);
    expect(fake.sent.at(-1)).toEqual({ type: "pty_resize", cols: 500, rows: 2 });
  });

  it("the kill ladder sends SIGHUP then SIGKILL, then waits for the exit", async () => {
    const { fake, clock, shell, exits } = setup();
    const killed = shell.kill({ pid: 0, start: null, exited: shell.pty.exited });
    await clock.advance(PTY_HANGUP_GRACE_MS - 1);
    expect(fake.sent).toEqual([{ type: "pty_signal", signal: "SIGHUP" }]);
    await clock.advance(1);
    expect(fake.sent.at(-1)).toEqual({ type: "pty_signal", signal: "SIGKILL" });
    fake.exit(null, "SIGKILL");
    await killed;
    expect(exits).toEqual([{ code: null, signal: "SIGKILL" }]);
    expect(fake.closedByDaemon).toBe(true);
  });

  it("the kill ladder stops at SIGHUP when the shell leaves", async () => {
    const { fake, shell } = setup();
    const killed = shell.kill({ pid: 0, start: null, exited: shell.pty.exited });
    fake.exit(0);
    await killed;
    expect(fake.sent.filter((frame) => frame.type === "pty_signal")).toHaveLength(1);
  });

  it("gives up with a warning when SIGKILL is not followed by an exit", async () => {
    const { clock, shell, exits, lines } = setup();
    const killed = shell.kill({ pid: 0, start: null, exited: shell.pty.exited });
    await clock.advance(PTY_HANGUP_GRACE_MS);
    await clock.advance(PTY_EXIT_WAIT_MS);
    await killed;
    expect(exits).toHaveLength(1);
    expect(lines.some((line) => line.event === "pty_kill_timeout" || line.msg === "pty_kill_timeout")).toBe(
      true,
    );
  });

  it("a lost link ends the terminal as exited", async () => {
    const { fake, shell, exits } = setup();
    fake.drop();
    await shell.pty.exited;
    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(shell.alive()).toBe(false);
    expect(fake.channel.send({ type: "pty_resize", cols: 80, rows: 24 })).toBe(false);
  });

  it("reports the shell's own exit and closes the connection", async () => {
    const { fake, shell, exits } = setup();
    fake.exit(3);
    await shell.pty.exited;
    expect(exits).toEqual([{ code: 3, signal: null }]);
    expect(fake.closedByDaemon).toBe(true);
  });
});
