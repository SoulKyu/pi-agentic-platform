import { describe, expect, it, vi } from "vitest";
import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "../../kernel/git/exec.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createLaneLocks } from "./lane-lock.ts";
import { createMutex, createPusher } from "./push.ts";
import type { LaneRow } from "./store.ts";

const GH = "https://github.com/o/r.git\n";
const GIT_DIR = "/repo/.git/worktrees/lane-1";
const row = {
  id: "lane-1",
  ownerId: "u1",
  worktree: "/wt/lane-1",
  branch: "pi/x",
  state: "active",
} as LaneRow;
const same = (a: readonly string[], b: readonly string[]) => a.join("\0") === b.join("\0");

interface Script {
  push?: string;
  pushRun?: { code: number; stderr?: string } | GitError;
  /** The push waits for this promise. */
  gate?: Promise<void>;
}
function fake(script: Script) {
  const pushes: string[][] = [];
  const events: string[] = [];
  const git: GitRunner = {
    async run(_root, args) {
      if (same(args, PUSH_SCAN_ARGS)) return { stdout: Buffer.alloc(0), code: 0 };
      if (same(args, ORIGIN_URLS_ARGS)) return { stdout: Buffer.from(GH), code: 0 };
      if (args[0] === "remote") return { stdout: Buffer.from(script.push ?? GH), code: 0 };
      if (args[0] === "push") {
        pushes.push([...args]);
        events.push("push:start");
        await script.gate;
        events.push("push:end");
        const run = script.pushRun ?? { code: 0 };
        if (run instanceof GitError) throw run;
        return { stdout: Buffer.alloc(0), code: run.code, stderr: run.stderr ?? "" };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  return { git, pushes, events };
}

function make(script: Script, over: { readOnly?: boolean; state?: LaneRow["state"] } = {}) {
  const { git, pushes, events } = fake(script);
  const locks = createLaneLocks(() => "lane-1");
  const audit: Array<Record<string, unknown>> = [];
  const factsRefresh = vi.fn(async () => undefined);
  const remoteRefresh = vi.fn(async () => undefined);
  const publish = vi.fn();
  const lane = { ...row, state: over.state ?? "active" } as LaneRow;
  const pusher = createPusher({
    store: { getOwned: (owner, id) => (owner === "u1" && id === "lane-1" ? lane : undefined) },
    git,
    gitDirOf: () => GIT_DIR,
    allowFile: false,
    audit: { append: (line) => void audit.push(line as unknown as Record<string, unknown>) },
    mutex: createMutex(),
    refreshFacts: factsRefresh,
    refreshRemote: remoteRefresh,
    publish,
    logger: silentLogger,
    readOnly: over.readOnly ?? false,
  });
  return { pusher, pushes, events, locks, audit, factsRefresh, remoteRefresh, publish };
}
const push = (m: ReturnType<typeof make>) => m.pusher.push(testCaller(), { laneId: "lane-1" });

describe("lanes.push", () => {
  it("answers the target, writes one audit row, and refreshes the facts", async () => {
    const m = make({});
    expect(await push(m)).toEqual({ ok: true, remote: { host: "github.com", path: "o/r" } });
    expect(m.pushes).toEqual([
      ["push", "--porcelain", "--set-upstream", "origin", "refs/heads/pi/x:refs/heads/pi/x"],
    ]);
    expect(m.audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "lane_pushed",
        detail: { laneId: "lane-1", host: "github.com", path: "o/r" },
      },
    ]);
    expect(m.factsRefresh).toHaveBeenCalledWith("lane-1");
    expect(m.remoteRefresh).toHaveBeenCalledWith("lane-1");
    expect(m.publish).toHaveBeenCalledWith("lane-1");
  });

  it("answers a refusal as a result, with no audit row", async () => {
    const m = make({ pushRun: { code: 1, stderr: " ! [rejected] pi/x -> pi/x (non-fast-forward)" } });
    expect(await push(m)).toEqual({ ok: false, reason: "rejected" });
    expect(m.audit).toEqual([]);
  });

  it("answers repo_config without pushing when the push URL is another repository", async () => {
    const m = make({ push: "https://github.com/o/other.git\n" });
    expect(await push(m)).toEqual({ ok: false, reason: "repo_config" });
    expect(m.pushes).toEqual([]);
  });

  it("maps a push timeout to the timeout error: the outcome is unknown, so no audit row and no retry", async () => {
    const m = make({ pushRun: new GitError("timeout") });
    await expect(push(m)).rejects.toMatchObject({ code: "timeout" });
    expect(m.audit).toEqual([]);
  });

  it("does not hold the lane lock: a capture on the same lane runs while the push is in flight", async () => {
    let release!: () => void;
    const m = make({ gate: new Promise<void>((resolve) => (release = resolve)) });
    const pushing = push(m);
    await vi.waitFor(() => expect(m.events).toEqual(["push:start"]));
    let captured = false;
    await m.locks.laneLock("lane-1").run("checkpoint", async () => void (captured = true));
    expect(captured).toBe(true);
    expect(m.events).toEqual(["push:start"]);
    release();
    await pushing;
  });

  it("makes a second push of the same lane wait for the first", async () => {
    let release!: () => void;
    const m = make({ gate: new Promise<void>((resolve) => (release = resolve)) });
    const first = push(m);
    const second = push(m);
    await vi.waitFor(() => expect(m.events).toEqual(["push:start"]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(m.events).toEqual(["push:start"]);
    release();
    await Promise.all([first, second]);
    expect(m.events).toEqual(["push:start", "push:end", "push:start", "push:end"]);
  });

  it("is the caller's own, writable and active lane", async () => {
    await expect(
      make({}).pusher.push(testCaller({ userId: "u2" }), { laneId: "lane-1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(push(make({}, { readOnly: true }))).rejects.toMatchObject({ code: "read_only" });
    const archived = make({}, { state: "archived" });
    expect(await push(archived)).toEqual({ ok: false, reason: "failed" });
    expect(archived.pushes).toEqual([]);
  });
});

describe("createMutex", () => {
  it("runs one function per key at a time, in order, and survives a failure", async () => {
    const mutex = createMutex();
    const order: string[] = [];
    const a = mutex.run("k", async () => {
      order.push("a");
      throw new Error("boom");
    });
    const b = mutex.run("k", async () => void order.push("b"));
    const other = mutex.run("other", async () => void order.push("other"));
    await expect(a).rejects.toThrow("boom");
    await Promise.all([b, other]);
    expect(order).toEqual(["a", "other", "b"]);
  });
});
