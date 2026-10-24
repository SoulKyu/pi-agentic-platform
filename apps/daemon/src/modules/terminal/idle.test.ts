import { afterEach, describe, expect, it } from "vitest";
import { createFakeBoxControl, createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { createFakeBoxPty, createFakeBoxTerminals } from "../../kernel/testing/fake-box-pty.ts";
import { makeModuleBed } from "./testing/module-bed.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ROOT = `/boxes/${PROJECT}/project`;
const IDLE_MS = 30 * 60_000;
/** The shell's last output counts for one idle time, and the box then waits its own: a silent terminal frees the box within two. */
const FREED_MS = 2 * IDLE_MS + 120_000;

let bed: ReturnType<typeof makeModuleBed>;
afterEach(() => bed.cleanup());

/** The box's idle wait as the runtime keeps it: every touch pushes the stop back by `IDLE_MS` from now. */
function setup() {
  const pty = createFakeBoxPty();
  const terminals = createFakeBoxTerminals([pty]);
  const source = createFakeProjectBoxSource({
    [PROJECT]: {
      ownerId: "u1",
      root: ROOT,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      deleting: false,
    },
  });
  const control = createFakeBoxControl({ [PROJECT]: "running" });
  bed = makeModuleBed({
    module: {
      idleMs: IDLE_MS,
      boxes: () => source,
      boxControl: () => control,
      boxTerminals: () => ({ open: terminals.open, touch: () => deadline.touch() }),
    },
  });
  const deadline = {
    stopAt: bed.clock.now() + IDLE_MS,
    touch() {
      deadline.stopAt = bed.clock.now() + IDLE_MS;
    },
  };
  const idledOut = (): boolean => bed.clock.now() >= deadline.stopAt;
  return { pty, deadline, idledOut };
}

describe("a box terminal and the box's idle time", () => {
  it("a detached silent terminal lets the box idle out", async () => {
    const { idledOut } = setup();
    await bed.create({ cwd: ROOT });
    await bed.clock.advance(FREED_MS);
    expect(idledOut()).toBe(true);
  });

  it("an attached terminal keeps it", async () => {
    const { idledOut } = setup();
    const id = await bed.create({ cwd: ROOT });
    bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    await bed.clock.advance(3 * IDLE_MS);
    expect(idledOut()).toBe(false);
  });

  it("a terminal that keeps printing keeps it, until it falls silent", async () => {
    const { pty, idledOut } = setup();
    await bed.create({ cwd: ROOT });
    for (let minute = 0; minute < 90; minute += 10) {
      pty.output("tick\n");
      await bed.clock.advance(10 * 60_000);
    }
    expect(idledOut()).toBe(false);
    await bed.clock.advance(FREED_MS);
    expect(idledOut()).toBe(true);
  });

  it("a box terminal that exited no longer counts", async () => {
    const { pty, idledOut } = setup();
    const id = await bed.create({ cwd: ROOT });
    bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    pty.exit(0);
    await bed.clock.advance(FREED_MS);
    expect(idledOut()).toBe(true);
  });
});
