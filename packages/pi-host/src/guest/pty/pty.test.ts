import { describe, expect, it, vi } from "vitest";
import { PTY_FOLDER_REFUSAL, PTY_WINDOW_BYTES } from "@pap/contracts";
import { SLOT, TOKEN } from "../../testing/guest-harness.ts";
import { open, rig } from "./rig.ts";

// Mutants, each killed by the case named:
//  - the cwd check accepts a link out of the project           -> "refuses a cwd outside the project"
//  - the window is not enforced / acks are not honoured        -> "stops reading past the window ..."
//  - SIGHUP kills the shell regardless of a trap, or SIGKILL does not end it -> "SIGHUP then SIGKILL ..."
//  - a closed connection leaves the shell alive                -> "a closed connection kills the pty"
describe("a box terminal's pty", () => {
  it("opens a shell in the asked folder and echoes input", async () => {
    const t = await rig();
    t.host.open(open(`${t.project}/sub`));
    await vi.waitFor(() => expect(t.hello()).toBeDefined());
    expect(t.hello()).toMatchObject({ type: "hello", role: "terminal", slot: SLOT, token: TOKEN });

    t.type("echo cwd=$(pwd) home=$HOME term=$TERM lang=$LANG $((6*7))mark\n");
    await t.sawOutput(`cwd=${t.project}/sub home=${t.home} term=xterm-256color lang=C.UTF-8 42mark`);
    t.type("env | grep -c PAP_GATEWAY_TOKEN; echo path=$PATH\n");
    await t.sawOutput("path=");
    expect(t.output()).not.toContain(TOKEN);

    t.send({ type: "pty_resize", cols: 100, rows: 30 });
    t.type("echo $(stty size)z\n");
    await t.sawOutput("30 100z");

    t.type("exit 3\n");
    await vi.waitFor(() => expect(t.exits()).toHaveLength(1));
    expect(t.exits()[0]).toEqual({ type: "pty_exit", code: 3, signal: null });
  });

  it("refuses a cwd outside the project", async () => {
    const t = await rig();
    for (const cwd of [
      t.dir,
      "/",
      `${t.project}/../`,
      `${t.project}/out`,
      `${t.project}/missing`,
      `${t.project}x`,
    ]) {
      t.host.open(open(cwd, { slot: String(t.refused.length).repeat(32) }));
    }
    expect(t.refused.map(([, why]) => why)).toEqual(Array(6).fill(PTY_FOLDER_REFUSAL));
    // The daemon reads this very text from the `exited` tail as `not_found`: changing it breaks that mapping.
    expect(PTY_FOLDER_REFUSAL).toBe("the folder is not in the project");
    expect(t.connects()).toBe(0);
  });

  it("refuses a slot used twice", async () => {
    const t = await rig();
    t.host.open(open(t.project));
    t.host.open(open(t.project));
    expect(t.logs.join("\n")).toContain("already used");
    await vi.waitFor(() => expect(t.hello()).toBeDefined());
    expect(t.connects()).toBe(1);
  });

  it("stops reading past the window and resumes on ack", { timeout: 30_000 }, async () => {
    const t = await rig();
    t.host.open(open(t.project));
    await vi.waitFor(() => expect(t.hello()).toBeDefined());
    t.type("yes abcdefghijklmnopqrstuvwxyz | head -c 6000000\n");
    await vi.waitFor(() => expect(t.receivedBytes()).toBeGreaterThanOrEqual(PTY_WINDOW_BYTES), {
      timeout: 10_000,
    });
    let last = -1;
    await vi.waitFor(
      () => {
        const now = t.receivedBytes();
        const before = last;
        last = now;
        expect(now).toBe(before);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(last).toBeLessThan(PTY_WINDOW_BYTES + 512 * 1024);
    t.send({ type: "pty_ack", bytes: last });
    await vi.waitFor(() => expect(t.receivedBytes()).toBeGreaterThan(last), { timeout: 10_000 });
    for (const frame of t.frames) {
      if (frame.type === "pty_output") {
        expect(Buffer.from(frame.data as string, "base64").length).toBeLessThanOrEqual(64 * 1024);
      }
    }
  });

  it("SIGHUP then SIGKILL end the shell", async () => {
    const t = await rig();
    t.host.open(open(t.project));
    await vi.waitFor(() => expect(t.hello()).toBeDefined());
    t.type("trap '' HUP\n");
    t.type("echo $((1+1))ready\n");
    await t.sawOutput("2ready");
    t.send({ type: "pty_signal", signal: "SIGHUP" });
    t.type("echo $((3+4))alive\n");
    await t.sawOutput("7alive");
    expect(t.exits()).toHaveLength(0);

    t.send({ type: "pty_signal", signal: "SIGKILL" });
    await vi.waitFor(() => expect(t.exits()).toHaveLength(1));
    expect(t.exits()[0]).toEqual({ type: "pty_exit", code: null, signal: "SIGKILL" });
  });

  it("a closed connection kills the pty", async () => {
    const t = await rig();
    t.host.open(open(t.project));
    await vi.waitFor(() => expect(t.hello()).toBeDefined());
    t.type("echo p$$q\n");
    await vi.waitFor(() => expect(t.output()).toMatch(/p\d+q/));
    const pid = Number(/p(\d+)q/.exec(t.output())?.[1]);
    expect(() => process.kill(pid, 0)).not.toThrow();
    t.hangUp();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
  });
});
