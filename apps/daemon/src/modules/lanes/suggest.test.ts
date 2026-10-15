import { type Caller, type HandlerContext, type HandlerTable, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { lanesSuggestRpc } from "./rpc-suggest.ts";
import { createLaneSuggest, type LaneSuggestDeps } from "./suggest.ts";
import { createLanesStore } from "./store.ts";
import { createLanesBed, type LanesBed } from "./testing/bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

const TREE = "c".repeat(40);
const caller = testCaller({ userId: "u1" });

let bed: LanesBed;
afterEach(() => bed.dispose());

type SuggestAnswer = Awaited<
  ReturnType<NonNullable<ReturnType<LaneSuggestDeps["sessions"]>>["suggestCommit"]>
>;

interface Setup {
  diff?: string;
  primary?: string | null;
  answer?: Awaited<ReturnType<NonNullable<ReturnType<LaneSuggestDeps["sessions"]>>["suggestCommit"]>>;
  state?: string;
  gitError?: GitError;
}

function make(script: Setup = {}) {
  bed = createLanesBed();
  insertLane(bed.db, { id: "lane-0001", ownerId: "u1", worktree: "/wt/lane-0001" });
  bed.db.run("UPDATE lanes SET state = $state, primary_session_id = $primary WHERE id = 'lane-0001'", {
    state: script.state ?? "active",
    primary: script.primary === undefined ? "s1" : script.primary,
  });
  insertLane(bed.db, { id: "lane-0002", ownerId: "u2", worktree: "/wt/lane-0002" });
  bed.db.run("UPDATE lanes SET state = 'active', primary_session_id = 's2' WHERE id = 'lane-0002'");
  const calls: Array<{ args: string[]; options: unknown }> = [];
  const git: GitRunner = {
    async run(_root, args, options) {
      calls.push({ args: [...args], options });
      if (script.gitError) throw script.gitError;
      return { stdout: Buffer.from(script.diff ?? "diff --git a/a.txt b/a.txt\n+one\n"), code: 0 };
    },
  };
  const snapshotTree = vi.fn(async () => ({ tree: TREE, skipped: 0, left: [] }));
  const suggestCommit = vi.fn<(caller: Caller, sessionId: string, diff: string) => Promise<SuggestAnswer>>(
    async () => script.answer ?? { ok: true, message: "feat: add one" },
  );
  const deps: LaneSuggestDeps = {
    git,
    logger: silentLogger,
    lanes: createLanesStore(bed.db),
    gitDirOf: (worktree) =>
      worktree === "/wt/lane-0002" ? undefined : `/repo/.git/worktrees/${worktree.slice(4)}`,
    indexDir: "/idx",
    readOnly: false,
    diskFloor: () => undefined,
    sessions: () => ({ suggestCommit }),
    ops: { snapshotTree },
  };
  return { suggest: createLaneSuggest(deps), calls, snapshotTree, suggestCommit, deps };
}

const params = { laneId: "lane-0001", paths: ["a.txt", "src"] };
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code,
  );

describe("lanes.suggestCommit (M9R80)", () => {
  it("snapshots only the selected paths and diffs HEAD against that tree", async () => {
    const t = make();
    const answer = await t.suggest.suggest(caller, params);
    expect(answer).toEqual({ ok: true, message: "feat: add one" });
    expect(t.snapshotTree).toHaveBeenCalledWith(
      expect.anything(),
      "/wt/lane-0001",
      "/repo/.git/worktrees/lane-0001",
      "/idx",
      ["a.txt", "src"],
    );
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.args).toEqual(["diff", "--no-color", "-U3", "-M", "HEAD", TREE, "--"]);
    expect(t.calls[0]?.options).toMatchObject({ gitDir: "/repo/.git/worktrees/lane-0001" });
    expect(t.suggestCommit).toHaveBeenCalledWith(caller, "s1", "diff --git a/a.txt b/a.txt\n+one\n");
  });

  it("checks the disk floor before the snapshot: a full disk answers disk_low, a read-only daemon read_only (M5)", async () => {
    const t = make();
    const full = createLaneSuggest({
      ...t.deps,
      diskFloor: () => {
        throw new PapError("disk_low");
      },
    });
    await expect(full.suggest(caller, params)).rejects.toMatchObject({ code: "disk_low" });
    await expect(
      createLaneSuggest({ ...t.deps, readOnly: true }).suggest(caller, params),
    ).rejects.toMatchObject({ code: "read_only" });
    expect(t.snapshotTree).not.toHaveBeenCalled();
    expect(t.suggestCommit).not.toHaveBeenCalled();
  });

  it("clips each file's part to 20 000 characters", async () => {
    const big = (name: string) => `diff --git a/${name} b/${name}\n${"+x\n".repeat(20_000)}`;
    const t = make({ diff: `${big("a")}${big("b")}` });
    await t.suggest.suggest(caller, params);
    const sent = t.suggestCommit.mock.calls[0]?.[2] as string;
    const parts = sent.split(/^(?=diff --git )/m);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(20_000);
      expect(part.startsWith("diff --git ")).toBe(true);
    }
  });

  it("clips the whole to 200 000 characters", async () => {
    const part = (n: number) => `diff --git a/${n} b/${n}\n${"y".repeat(15_000)}\n`;
    const t = make({ diff: Array.from({ length: 30 }, (_, n) => part(n)).join("") });
    await t.suggest.suggest(caller, params);
    const sent = t.suggestCommit.mock.calls[0]?.[2] as string;
    expect(sent.length).toBeLessThanOrEqual(200_000);
    expect(sent.length).toBeGreaterThan(190_000);
  });

  it("answers nothing for an empty diff, without asking the model", async () => {
    const t = make({ diff: "  \n" });
    expect(await t.suggest.suggest(caller, params)).toEqual({ ok: false, reason: "nothing" });
    expect(t.suggestCommit).not.toHaveBeenCalled();
  });

  it("answers no_session with no primary session, before touching git", async () => {
    const t = make({ primary: null });
    expect(await t.suggest.suggest(caller, params)).toEqual({ ok: false, reason: "no_session" });
    expect(t.snapshotTree).not.toHaveBeenCalled();
    expect(t.suggestCommit).not.toHaveBeenCalled();
  });

  it("passes a model failure on as model_failed", async () => {
    const t = make({ answer: { ok: false, reason: "model_failed" } });
    expect(await t.suggest.suggest(caller, params)).toEqual({ ok: false, reason: "model_failed" });
  });

  it.each([
    ["another owner's lane", { laneId: "lane-0002", paths: ["a"] }],
    ["a missing lane", { laneId: "nope", paths: ["a"] }],
  ])("answers not_found for %s", async (_name, input) => {
    const t = make();
    expect(await code(t.suggest.suggest(caller, input))).toBe("not_found");
    expect(t.suggestCommit).not.toHaveBeenCalled();
  });

  it("answers not_found for a lane that is not active", async () => {
    const t = make({ state: "archived" });
    expect(await code(t.suggest.suggest(caller, params))).toBe("not_found");
  });

  it.each([
    ["timeout", "timeout"],
    ["failed", "capacity"],
  ] as const)("maps a git %s to %s", async (kind, expected) => {
    const t = make({ gitError: new GitError(kind) });
    expect(await code(t.suggest.suggest(caller, params))).toBe(expected);
  });
});

describe("lanes.suggestCommit behind the dispatcher", () => {
  it("asks the model once for a commandId, however often the client sends it", async () => {
    const t = make();
    const receipts = createReceiptStore(bed.db, bed.clock);
    const handlers = lanesSuggestRpc(t.suggest) as unknown as HandlerTable;
    const dispatch = createDispatcher({ handlers, receipts, logger: silentLogger });
    const ctx: HandlerContext = {
      caller: caller as Caller,
      connectionId: "c1",
      openSubscription: () => "s1",
      closeSubscription: () => {},
    };
    const frame = (id: number) => ({
      id,
      method: "lanes.suggestCommit",
      params,
      commandId: "command-0001",
    });
    const first = await dispatch(frame(1) as never, ctx);
    const again = await dispatch(frame(2) as never, ctx);
    expect(first).toEqual({ id: 1, ok: true, result: { ok: true, message: "feat: add one" } });
    expect(again).toEqual({ id: 2, ok: true, result: { ok: true, message: "feat: add one" } });
    expect(t.suggestCommit).toHaveBeenCalledTimes(1);
  });
});

describe("lanes.suggestCommit single-flight and owner cap", () => {
  const second = { laneId: "lane-0003", paths: ["a.txt"] };
  const third = { laneId: "lane-0004", paths: ["a.txt"] };
  const more = () => {
    for (const id of ["lane-0003", "lane-0004"]) {
      insertLane(bed.db, { id, ownerId: "u1", worktree: `/wt/${id}` });
      bed.db.run("UPDATE lanes SET state = 'active', primary_session_id = 's' || id WHERE id = $id", { id });
    }
  };
  const gated = (t: ReturnType<typeof make>) => {
    const release: Array<(value: SuggestAnswer) => void> = [];
    t.suggestCommit.mockImplementation(
      () => new Promise<SuggestAnswer>((resolve) => void release.push(resolve)),
    );
    const open = (): void => release.shift()?.({ ok: true, message: "feat: shared" });
    return { open, pending: () => release.length };
  };
  const ready = async (t: ReturnType<typeof make>, calls: number) => {
    await vi.waitFor(() => expect(t.suggestCommit).toHaveBeenCalledTimes(calls));
  };

  it("shares one model call between concurrent calls on a lane, and both get the same text", async () => {
    const t = make();
    const g = gated(t);
    const a = t.suggest.suggest(caller, params);
    const b = t.suggest.suggest(caller, params);
    await ready(t, 1);
    g.open();
    expect(await a).toEqual({ ok: true, message: "feat: shared" });
    expect(await b).toEqual({ ok: true, message: "feat: shared" });
    expect(t.suggestCommit).toHaveBeenCalledTimes(1);
  });

  it("answers capacity to a third lane while two are in flight, and frees the slot afterwards", async () => {
    const t = make();
    more();
    const g = gated(t);
    const a = t.suggest.suggest(caller, params);
    const b = t.suggest.suggest(caller, second);
    await ready(t, 2);
    expect(await code(t.suggest.suggest(caller, third))).toBe("capacity");
    expect(t.suggestCommit).toHaveBeenCalledTimes(2);
    g.open();
    g.open();
    await Promise.all([a, b]);
    const c = t.suggest.suggest(caller, third);
    await ready(t, 3);
    g.open();
    expect(await c).toEqual({ ok: true, message: "feat: shared" });
  });

  it("clears the in-flight entry after a failure, so a retry asks again", async () => {
    const t = make();
    t.suggestCommit.mockRejectedValueOnce(new PapError("worker_failed"));
    expect(await code(t.suggest.suggest(caller, params))).toBe("worker_failed");
    expect(await t.suggest.suggest(caller, params)).toEqual({ ok: true, message: "feat: add one" });
    expect(t.suggestCommit).toHaveBeenCalledTimes(2);
  });
});
