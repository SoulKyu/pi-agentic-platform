import {
  type BoxOpValue,
  type HandlerContext,
  PapError,
  VCS_LIMITS,
  type StreamName,
  type VcsStatus,
} from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeBoxControl,
  createFakeBoxOps,
  createFakeProjectBoxSource,
} from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createVcsModule } from "./index.ts";
import { createVcsBed, type VcsBed } from "./testing/vcs-bed.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ROOT = `/boxes/${PROJECT}/project`;
const never = {
  run: async () => {
    throw new Error("host git was called");
  },
};
const status = (branch: string): VcsStatus => ({
  root: "/guest/elsewhere",
  repo: true,
  branch,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  truncated: false,
  additions: 0,
  deletions: 0,
  at: 1,
  error: null,
});
const meta = (size: number, binary = false) => ({
  path: `${ROOT}/a.txt`,
  size,
  mtimeMs: 1,
  etag: "a".repeat(32),
  binary,
  editable: true,
  protection: "none" as const,
});

let bed: VcsBed;
let stop: () => void;
beforeEach(() => {
  bed = createVcsBed();
  stop = () => undefined;
});
afterEach(() => {
  stop();
  bed.dispose();
});

function setup(
  phase: "stopped" | "running",
  branch = "main",
  read?: (op: { offset: number }) => BoxOpValue<"fs.read">,
) {
  const published: Array<{ key: string; status: VcsStatus }> = [];
  const opened: Array<[StreamName, string]> = [];
  const control = createFakeBoxControl({ [PROJECT]: phase });
  const ops = createFakeBoxOps({
    "git.status": () => status(branch),
    "fs.read": (op) => read?.(op) ?? { meta: meta(3), text: `work ${op.path}`, offset: 0, nextOffset: null },
    "git.blob": (op) => ({ text: `${op.side.kind}:${op.path}`, binary: false, truncated: false }),
  });
  const boxes = createFakeProjectBoxSource({
    [PROJECT]: {
      ownerId: "u1",
      root: ROOT,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      deleting: false,
    },
  });
  const module = createVcsModule({
    roots: (ownerId) => (ownerId === "u1" ? [ROOT] : []),
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: never,
    hub: {
      registerSnapshot: () => undefined,
      publish: (_stream, key, event) =>
        void published.push({ key, status: (event as { status: VcsStatus }).status }),
      hasSubscribers: (stream, key) => opened.some(([s, k]) => s === stream && k === key),
    },
    clock: bed.clock,
    logger: bed.logger,
    boxes: () => boxes,
    boxOps: () => ops,
    boxControl: () => control,
  });
  stop = () => module.shutdown();
  const ctx = (): HandlerContext => ({
    caller: testCaller(),
    connectionId: "c1",
    openSubscription: (stream, key) => {
      opened.push([stream, key]);
      return "s1";
    },
    closeSubscription: () => undefined,
  });
  return { module, published, control, ops, ctx };
}
const code = async (run: Promise<unknown>) => ((await run.catch((e: unknown) => e)) as PapError).code;

describe("Changes of a box project", () => {
  it("status of a running box comes from the guest", async () => {
    const { module, published, ops, ctx } = setup("running");
    await module.rpc["subscribe.vcs"]({ root: ROOT }, ctx());
    await bed.clock.advance(0);
    expect(ops.calls.map((call) => call.op.name)).toEqual(["git.status"]);
    expect(published).toEqual([{ key: ROOT, status: { ...status("main"), root: ROOT } }]);
  });

  it("answers box_stopped for a stopped box on every vcs method, and reads nothing", async () => {
    const { module, ops, control, ctx } = setup("stopped");
    expect(await code(module.rpc["subscribe.vcs"]({ root: ROOT }, ctx()))).toBe("box_stopped");
    expect(await code(module.rpc["vcs.refresh"]({ root: ROOT }, ctx()))).toBe("box_stopped");
    const side = { kind: "head" } as const;
    const diff = { root: ROOT, path: "a.txt", from: side, to: { kind: "worktree" } } as const;
    expect(await code(module.rpc["vcs.fileDiff"](diff, ctx()))).toBe("box_stopped");
    expect(ops.calls).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it("the poll skips a stopped box", async () => {
    const { module, published, control, ops, ctx } = setup("running");
    await module.rpc["subscribe.vcs"]({ root: ROOT }, ctx());
    await bed.clock.advance(0);
    control.setPhase(PROJECT, "stopped");
    ops.calls.length = 0;
    published.length = 0;
    await bed.clock.advance(60_000);
    expect(ops.calls).toEqual([]);
    expect(ops.polls).toEqual([]);
    expect(published).toEqual([]);
  });

  it("the poll's own timer polls and never calls, so watching Changes does not keep a box alive; a person's read calls", async () => {
    const { module, ops, ctx } = setup("running");
    await module.rpc["subscribe.vcs"]({ root: ROOT }, ctx());
    await bed.clock.advance(0);
    expect(ops.calls.map((call) => call.op.name)).toEqual(["git.status"]);
    expect(ops.polls).toEqual([]);
    await bed.clock.advance(VCS_LIMITS.pollMs);
    expect(ops.polls.map((call) => call.op.name)).toEqual(["git.status"]);
    expect(ops.calls).toHaveLength(1);
    await module.rpc["vcs.refresh"]({ root: ROOT }, ctx());
    await bed.clock.advance(0);
    expect(ops.calls).toHaveLength(2);
  });

  it("running triggers a refresh", async () => {
    const { module, published, control, ops, ctx } = setup("running");
    await module.rpc["subscribe.vcs"]({ root: ROOT }, ctx());
    await bed.clock.advance(0);
    control.setPhase(PROJECT, "stopped");
    ops.calls.length = 0;
    control.setPhase(PROJECT, "running");
    await bed.clock.advance(0);
    expect(ops.calls.map((call) => call.op.name)).toEqual(["git.status"]);
    expect(published.length).toBeGreaterThan(0);
  });

  it("refuses a subfolder of the project folder and never starts the box", async () => {
    const { module, ops, ctx } = setup("running");
    expect(await code(module.rpc["subscribe.vcs"]({ root: `${ROOT}/sub` }, ctx()))).toBe("not_found");
    expect(ops.calls).toEqual([]);
  });

  it("fileDiff reads the worktree side from fs.read and the others from git.blob", async () => {
    const { module, ops, ctx } = setup("running");
    const answer = await module.rpc["vcs.fileDiff"](
      { root: ROOT, path: "a.txt", oldPath: "b.txt", from: { kind: "head" }, to: { kind: "worktree" } },
      ctx(),
    );
    expect(answer).toEqual({
      before: "head:b.txt",
      after: `work ${ROOT}/a.txt`,
      binary: false,
      truncated: false,
    });
    expect(ops.calls.map((call) => call.op.name)).toEqual(["git.blob", "fs.read"]);
  });

  it("fileDiff gives an empty side for a missing worktree file and truncated for a large one", async () => {
    let reply: () => ReturnType<typeof meta> | PapError = () => new PapError("not_found");
    const { module, ctx } = setup("running", "main", () => {
      const given = reply();
      if (given instanceof PapError) throw given;
      return { meta: given, text: "big", offset: 0, nextOffset: null };
    });
    const diff = { root: ROOT, path: "a.txt", from: { kind: "head" }, to: { kind: "worktree" } } as const;
    expect(await module.rpc["vcs.fileDiff"](diff, ctx())).toEqual({
      before: "head:a.txt",
      after: null,
      binary: false,
      truncated: false,
    });
    reply = () => meta(VCS_LIMITS.diffSideBytes + 1);
    expect(await module.rpc["vcs.fileDiff"](diff, ctx())).toMatchObject({
      before: null,
      after: null,
      truncated: true,
    });
    reply = () => meta(3, true);
    expect(await module.rpc["vcs.fileDiff"](diff, ctx())).toMatchObject({ binary: true });
  });

  it("fileDiff refuses a name the boundary hides from a token before the guest is asked", async () => {
    const { module, ops } = setup("running");
    const token = (): HandlerContext => ({
      caller: testCaller({ kind: "token" }),
      connectionId: "c1",
      openSubscription: () => "s1",
      closeSubscription: () => undefined,
    });
    const run = module.rpc["vcs.fileDiff"](
      { root: ROOT, path: ".pi/mcp.json", from: { kind: "head" }, to: { kind: "index" } },
      token(),
    );
    expect(await code(run)).toBe("not_found");
    expect(ops.calls).toEqual([]);
  });
});
