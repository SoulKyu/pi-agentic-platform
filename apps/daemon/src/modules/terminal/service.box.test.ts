import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBoxControl, createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { makeModuleBed } from "./testing/module-bed.ts";
import { createFakeBoxPty, createFakeBoxTerminals } from "../../kernel/testing/fake-box-pty.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ROOT = `/boxes/${PROJECT}/project`;

let bed: ReturnType<typeof makeModuleBed>;
afterEach(() => bed.cleanup());

function setup(phase: "running" | "stopped", ptys = [createFakeBoxPty()], max?: number) {
  const control = createFakeBoxControl({ [PROJECT]: phase });
  const terminals = createFakeBoxTerminals(ptys);
  const source = createFakeProjectBoxSource({
    [PROJECT]: {
      ownerId: "u1",
      root: ROOT,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      deleting: false,
    },
  });
  bed = makeModuleBed({
    ...(max ? { max } : {}),
    module: { boxes: () => source, boxControl: () => control, boxTerminals: () => terminals },
  });
  return { control, terminals, ptys };
}

describe("create in a box", () => {
  it("a box cwd opens a box terminal and starts a stopped box", async () => {
    const { control, terminals } = setup("stopped");
    const id = await bed.create({ cwd: `${ROOT}/src` });
    expect(control.calls).toEqual([["start", PROJECT]]);
    expect(terminals.opened).toEqual([{ projectId: PROJECT, cwd: `${ROOT}/src`, cols: 80, rows: 24 }]);
    expect(bed.fake.spawn).not.toHaveBeenCalled();
    expect(bed.listed()).toMatchObject({
      terminals: [{ id, cwd: `${ROOT}/src`, projectId: PROJECT, status: "running" }],
    });
  });

  it("does not start a box that already runs", async () => {
    const { control } = setup("running");
    await bed.create({ cwd: ROOT });
    expect(control.calls).toEqual([]);
  });

  it("a host terminal has no project", async () => {
    setup("running");
    await bed.create({});
    expect(bed.listed()).toMatchObject({ terminals: [{ projectId: null }] });
  });

  it("a refused start answers its code and opens nothing", async () => {
    const { control, terminals } = setup("stopped");
    control.start = () => Promise.reject(new PapError("agent_paused"));
    await expect(bed.create({ cwd: ROOT })).rejects.toMatchObject({ code: "agent_paused" });
    expect(terminals.opened).toEqual([]);
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });

  it("answers the guest's refusal of the pty and lists nothing", async () => {
    const { terminals } = setup("running");
    terminals.open = () => Promise.reject(new PapError("terminal_unavailable"));
    await expect(bed.create({ cwd: ROOT })).rejects.toMatchObject({ code: "terminal_unavailable" });
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });

  it("refuses the owner at capacity before the pty is opened", async () => {
    const first = createFakeBoxPty();
    const second = createFakeBoxPty();
    const { terminals } = setup("running", [first, second], 1);
    await bed.create({ cwd: ROOT });
    await expect(bed.create({ cwd: ROOT, requestId: "q".repeat(16) })).rejects.toMatchObject({
      code: "capacity",
    });
    expect(terminals.opened).toHaveLength(1);
    expect(second.closedByDaemon).toBe(false);
  });

  it("closing a box terminal climbs the remote ladder, never a host pid", async () => {
    const { ptys } = setup("running");
    const [pty] = ptys;
    const id = await bed.create({ cwd: ROOT });
    const closing = bed.rpc["terminal.close"]({ terminalId: id }, bed.ctxOf());
    await Promise.resolve();
    pty?.exit(0);
    await closing;
    expect(pty?.sent).toContainEqual({ type: "pty_signal", signal: "SIGHUP" });
    expect(bed.kill).not.toHaveBeenCalled();
  });

  it("a lost link ends the terminal as exited", async () => {
    const { ptys } = setup("running");
    const id = await bed.create({ cwd: ROOT });
    ptys[0]?.drop();
    await bed.clock.advance(1100);
    expect(bed.listed()).toMatchObject({ terminals: [{ id, status: "exited" }] });
  });
});
