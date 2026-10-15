import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { autoTestListener } from "./auto-test.ts";
import type { ScriptRunner } from "./scripts.ts";
import type { LaneRow } from "./store.ts";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";

const TEST = "echo tested";
const lane = (over: Partial<LaneRow> = {}): LaneRow =>
  ({
    id: "demo-0a1b",
    ownerId: "u1",
    projectRoot: "/srv/repo",
    worktree: "/srv/wt/demo",
    fanoutId: "1111111111111111",
    primarySessionId: "s1",
    firstRunEndedAt: null,
    createdBy: "session",
    source: { kind: "description" },
    ...over,
  }) as LaneRow;
const pick = <T>(list: readonly T[], at: number): T => {
  const found = list[at];
  if (found === undefined) throw new Error(`no item ${at}`);
  return found;
};
const first = <T>(list: readonly T[]): T => pick(list, 0);
const info = (sessionId = "s1") => ({ ownerId: "u1", sessionId, cwd: "/srv/wt/demo", leafId: null });

function listener(over: { tainted?: boolean; readOnly?: boolean; fail?: boolean } = {}) {
  const run = vi.fn<ScriptRunner["run"]>(async () => {
    if (over.fail) throw new Error("boom");
    return { ok: true };
  });
  const rows = new Map<string, LaneRow>();
  const state = { tainted: over.tainted === true };
  const noticed: string[] = [];
  const published: string[] = [];
  const warnings: string[] = [];
  const handle = autoTestListener({
    scripts: { run },
    store: { get: (id) => rows.get(id) },
    notices: { add: (_id, kind) => void noticed.push(kind) },
    tainted: () => state.tainted,
    logger: { ...silentLogger, warn: (message: string) => void warnings.push(message) },
    readOnly: over.readOnly === true,
    publish: (laneId) => void published.push(laneId),
  });
  return { handle, run, published, warnings, rows, state, noticed };
}

describe("the test auto-run rule (M9R84), the listener", () => {
  it("runs the test script of a browser, untainted, non-issue group lane once, when the primary session's first run ends", async () => {
    const { handle, run, published } = listener();
    handle(lane(), info());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      { id: "demo-0a1b", ownerId: "u1", projectRoot: "/srv/repo", worktree: "/srv/wt/demo" },
      "test",
      { guard: expect.any(Function), dropped: expect.any(Function) },
    );
    await vi.waitFor(() => expect(published).toEqual(["demo-0a1b"]));
    // A later run (the row now has its first end), and the same stale row again: nothing.
    handle(lane({ firstRunEndedAt: 5 }), info());
    handle(lane(), info());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "an issue lane",
      over: { source: { kind: "issue", forge: "github", url: "https://github.com/o/r/issues/1", number: 1 } },
    },
    { name: "a token-created lane", over: { createdBy: "token" } },
    { name: "a lane that is no group's", over: { fanoutId: null } },
    { name: "a run of a session that is not the primary one", over: {}, session: "s2" },
    { name: "a run past the first", over: { firstRunEndedAt: 5 } },
  ] as const)("runs nothing for $name", ({ over, ...rest }) => {
    const { handle, run } = listener();
    handle(lane(over as Partial<LaneRow>), info("session" in rest ? rest.session : undefined));
    expect(run).not.toHaveBeenCalled();
  });

  it("runs nothing when a session of the lane is tainted at that moment, nor on a read-only database", () => {
    const tainted = listener({ tainted: true });
    tainted.handle(lane(), info());
    expect(tainted.run).not.toHaveBeenCalled();
    const readOnly = listener({ readOnly: true });
    readOnly.handle(lane(), info());
    expect(readOnly.run).not.toHaveBeenCalled();
  });

  it("hands the runner a guard that judges the lane again at the spawn, and says so when it drops the run", () => {
    const { handle, run, rows, state, noticed } = listener();
    handle(lane(), info());
    const options = run.mock.calls[0]?.[2];
    const guard = options?.guard as () => boolean;
    rows.set("demo-0a1b", lane({ state: "active" }));
    expect(guard()).toBe(true);
    state.tainted = true;
    expect(guard()).toBe(false);
    state.tainted = false;
    for (const over of [
      { state: "archiving" },
      { createdBy: "token" },
      { source: { kind: "issue" } },
    ] as const) {
      rows.set("demo-0a1b", lane({ state: "active", ...over } as Partial<LaneRow>));
      expect(guard()).toBe(false);
    }
    rows.delete("demo-0a1b");
    expect(guard()).toBe(false);
    options?.dropped?.();
    expect(noticed).toEqual(["auto_test_dropped"]);
  });

  it("logs a refusal of the runner and never throws into the run's end", async () => {
    const { handle, warnings } = listener({ fail: true });
    expect(() => handle(lane(), info())).not.toThrow();
    await vi.waitFor(() => expect(warnings).toEqual(["lane_auto_test_failed"]));
  });
});

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});

/** A group whose lanes' first run "ends": the service's own run hooks, then a probe listener that runs after the rule's. */
async function group(b: CreateBed, over: Parameters<CreateBed["params"]>[0] = {}, caller = b.browser()) {
  let n = 0;
  b.behaviour.session = async () => ({ sessionId: `s${++n}`, modelRefused: false });
  const answer = await b.service.create(caller, b.params({ models: [null, null], ...over }));
  await vi.waitFor(
    () => expect(answer.laneIds.map((id) => b.view(id).primarySessionId)).not.toContain(null),
    { timeout: 5000 },
  );
  const lanes = answer.laneIds.map((id) => b.view(id));
  const probed: string[] = [];
  b.service.checkpoints.onAfterRun((row) => void probed.push(row.id));
  const end = async (at: number) => {
    const view = pick(lanes, at);
    const before = probed.length;
    b.service.checkpoints.afterRun({
      ownerId: "u1",
      sessionId: view.primarySessionId as string,
      cwd: view.worktree,
      leafId: null,
    });
    await vi.waitFor(() => expect(probed).toHaveLength(before + 1), { timeout: 5000 });
  };
  return { lanes, end };
}

describe("the test auto-run rule, wired into the run hooks", () => {
  /** Three lanes, two tests running, the third queued behind the per-owner cap. */
  async function queuedThird(b: CreateBed) {
    const g = await group(b, { models: [null, null, null] });
    await g.end(0);
    await g.end(1);
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(2), { timeout: 5000 });
    await g.end(2);
    await vi.waitFor(() => expect(b.view(pick(g.lanes, 2).id).tests.state).toBe("queued"), { timeout: 5000 });
    return g;
  }

  it("does not run a queued test in a lane that was tainted while it waited, and says so", async () => {
    const b = (bed = createCreateBed());
    b.writeConfig(`test: ${TEST}\n`);
    await b.approve({ setup: undefined, archive: undefined, test: TEST });
    const { lanes } = await queuedThird(b);
    b.behaviour.sessionIds = ["s1", "s2", "s3"];
    b.behaviour.tainted.add("s3");
    b.fakes.child(0).end({ code: 0, signal: null });
    const third = pick(lanes, 2).id;
    await vi.waitFor(() => expect(b.view(third).tests.state).toBe("none"), { timeout: 5000 });
    expect(b.fakes.children).toHaveLength(2);
    expect(b.view(third).notices.map((n) => n.kind)).toContain("auto_test_dropped");
  });

  it("does not run a queued test in a lane that began archiving while it waited", async () => {
    const b = (bed = createCreateBed());
    b.writeConfig(`test: ${TEST}\n`);
    await b.approve({ setup: undefined, archive: undefined, test: TEST });
    const { lanes } = await queuedThird(b);
    const third = pick(lanes, 2).id;
    b.db.run("UPDATE lanes SET state = 'archiving' WHERE id = $id", { id: third });
    b.fakes.child(0).end({ code: 0, signal: null });
    await vi.waitFor(() => expect(b.view(third).tests.state).toBe("none"), { timeout: 5000 });
    expect(b.fakes.children).toHaveLength(2);
  });

  const withTest = async (b: CreateBed) => {
    b.writeConfig(`test: ${TEST}\n`);
    await b.approve({ setup: undefined, archive: undefined, test: TEST });
  };

  it("runs the approved test once per lane after its first run, and not after the second", async () => {
    const b = (bed = createCreateBed());
    await withTest(b);
    const { lanes, end } = await group(b);
    await end(0);
    expect(b.fakes.children).toHaveLength(1);
    expect(b.fakes.child(0).cwd).toBe(first(lanes).worktree);
    // The unattended environment: the agent socket of the daemon never reaches the script, and the lane's facts do.
    expect(b.fakes.child(0).spec.env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(b.fakes.child(0).spec.args.join(" ")).toContain(TEST);
    b.fakes.child(0).end({ code: 0, signal: null });
    await vi.waitFor(() => expect(b.view(first(lanes).id).tests.state).toBe("passed"), { timeout: 5000 });
    await end(0);
    expect(b.fakes.children).toHaveLength(1);
    await end(1);
    expect(b.fakes.children).toHaveLength(2);
    expect(b.fakes.child(1).cwd).toBe(pick(lanes, 1).worktree);
  });

  it("runs nothing for an issue group", async () => {
    const b = (bed = createCreateBed());
    await withTest(b);
    const { end, lanes } = await group(b, {
      description: "",
      issue: {
        forge: "github",
        url: "https://github.com/o/r/issues/7",
        number: 7,
        title: "t",
        body: "b",
        state: "OPEN",
        labels: [],
        truncated: false,
      },
    });
    await end(0);
    await end(1);
    expect(b.fakes.children).toHaveLength(0);
    expect(lanes.map((view) => b.view(view.id).tests.state)).toEqual(["none", "none"]);
  });

  it("runs nothing for a token group", async () => {
    const b = (bed = createCreateBed());
    await withTest(b);
    const { end } = await group(b, {}, b.token());
    await end(0);
    expect(b.fakes.children).toHaveLength(0);
  });

  it("runs nothing when a session of the lane is tainted", async () => {
    const b = (bed = createCreateBed());
    await withTest(b);
    const { end } = await group(b);
    b.behaviour.sessionIds = ["s1", "s2"];
    b.behaviour.tainted.add("s2");
    await end(0);
    expect(b.fakes.children).toHaveLength(0);
  });

  it("runs nothing without an approved test, and says so with the state none", async () => {
    const b = (bed = createCreateBed());
    const { end, lanes } = await group(b);
    await end(0);
    expect(b.fakes.children).toHaveLength(0);
    expect(b.view(first(lanes).id).tests.state).toBe("none");
  });

  it("runs nothing when the test text changed since the owner approved it", async () => {
    const b = (bed = createCreateBed());
    await withTest(b);
    b.writeConfig("test: echo changed\n");
    const { end, lanes } = await group(b);
    await end(0);
    expect(b.fakes.children).toHaveLength(0);
    expect(b.view(first(lanes).id).tests.state).toBe("unapproved");
  });
});
