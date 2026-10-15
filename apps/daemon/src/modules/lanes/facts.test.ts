import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createLaneFacts, FACTS_STALE_MS } from "./facts.ts";
import type { LaneRow } from "./store.ts";

const row = {
  id: "lane-1",
  ownerId: "u1",
  worktree: "/wt/lane-1",
  baseRef: "refs/heads/main",
  state: "active",
};
const NOW = 1_700_000_000_000;
const buf = (text: string) => Buffer.from(text);

interface Script {
  status?: string;
  mergeBase?: string;
  ahead?: string;
  behind?: string;
  numstat?: string;
  fail?: (args: readonly string[]) => GitError | undefined;
  gate?: Promise<void>;
}

function fakeGit(script: Script) {
  const calls: string[][] = [];
  const git: GitRunner = {
    async run(_root, args) {
      calls.push([...args]);
      const failure = script.fail?.(args);
      if (failure) throw failure;
      if (script.gate && args[0] === "status") await script.gate;
      switch (args[0]) {
        case "status":
          return { stdout: buf(script.status ?? "# branch.oid abc\0# branch.head lane\0"), code: 0 };
        case "merge-base":
          return { stdout: buf(script.mergeBase ?? "mb1\n"), code: 0 };
        case "rev-list":
          return {
            stdout: buf(args.includes("mb1..HEAD") ? (script.ahead ?? "0\n") : (script.behind ?? "0\n")),
            code: 0,
          };
        case "diff":
          return { stdout: buf(script.numstat ?? ""), code: 0 };
        default:
          throw new Error(`unexpected ${args.join(" ")}`);
      }
    },
  };
  return { git, calls };
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

function make(script: Script, over: { rows?: Record<string, Partial<LaneRow>> } = {}) {
  const { git, calls } = fakeGit(script);
  const clock = createFakeClock();
  const changed: string[] = [];
  const facts = createLaneFacts({
    git,
    clock,
    logger: silentLogger,
    store: { get: (id) => ({ ...row, ...over.rows?.[id], id }) as unknown as LaneRow },
    gitDirOf: () => "/home/.pap/repo/.git/worktrees/lane-1",
    changed: (id) => void changed.push(id),
  });
  stop = () => facts.settled();
  return { facts, calls, clock, changed };
}

const STATUS =
  "# branch.oid abc\0# branch.head lane\0# branch.upstream origin/lane\0# branch.ab +2 -0\0" +
  "1 .M N... 100644 100644 100644 a b src/x.ts\0? new.txt\0";

describe("lane facts", () => {
  it("reads dirty and unpushed from the porcelain header, and ahead, behind and the diff from the base", async () => {
    const { facts, calls } = make({
      status: STATUS,
      ahead: "3\n",
      behind: "1\n",
      numstat: "5\t2\tsrc/x.ts\0-\t-\timg.png\0",
    });
    await facts.refresh("lane-1");
    expect(facts.get("lane-1")).toEqual({
      dirty: 2,
      unpushed: 2,
      ahead: 3,
      behind: 1,
      additions: 5,
      deletions: 2,
      checkedAt: NOW,
      error: null,
    });
    expect(calls.map((c) => c[0])).toEqual(["status", "merge-base", "rev-list", "rev-list", "diff"]);
    expect(calls[1]).toEqual(["merge-base", "refs/heads/main", "HEAD"]);
    expect(calls[2]).toEqual(["rev-list", "--count", "mb1..HEAD"]);
    expect(calls[3]).toEqual(["rev-list", "--count", "mb1..refs/heads/main"]);
    expect(calls[4]).toEqual(["diff", "--numstat", "-z", "--ignore-submodules=dirty", "mb1", "--"]);
  });

  it("has no unpushed count without an upstream", async () => {
    const { facts } = make({ status: "# branch.oid abc\0# branch.head lane\0" });
    await facts.refresh("lane-1");
    expect(facts.get("lane-1")).toMatchObject({ dirty: 0, unpushed: null, error: null });
  });

  it("fills error and nulls on a git timeout", async () => {
    const { facts } = make({ fail: (args) => (args[0] === "status" ? new GitError("timeout") : undefined) });
    await facts.refresh("lane-1");
    expect(facts.get("lane-1")).toEqual({
      dirty: null,
      unpushed: null,
      ahead: null,
      behind: null,
      additions: null,
      deletions: null,
      checkedAt: NOW,
      error: "timeout",
    });
  });

  it("reports failed for an error that is not git's", async () => {
    const { facts } = make({
      fail: () => {
        throw new Error("surprise");
      },
    });
    await facts.refresh("lane-1");
    expect(facts.get("lane-1")?.error).toBe("failed");
  });

  it("runs one more refresh, exactly one, for any number of triggers during a run", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { facts, calls } = make({ gate });
    const first = facts.refresh("lane-1");
    const again = [facts.refresh("lane-1"), facts.refresh("lane-1"), facts.refresh("lane-1")];
    open();
    await Promise.all([first, ...again]);
    expect(calls.filter((c) => c[0] === "status")).toHaveLength(2);
  });

  it("tells the lane stream when facts changed, and not for a lane that is gone", async () => {
    const { facts, changed } = make({});
    await facts.refresh("lane-1");
    expect(changed).toEqual(["lane-1"]);
  });

  it("refreshes in the background a lane whose facts are older than 30 s, two lanes at a time", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { facts, calls } = make({ gate });
    for (const id of ["l1", "l2", "l3"]) expect(facts.view(id)).toBeNull();
    await vi.waitFor(() => expect(calls.filter((c) => c[0] === "status")).toHaveLength(2));
    open();
    await vi.waitFor(() => expect(calls.filter((c) => c[0] === "status")).toHaveLength(3));
    await facts.settled();
    expect(facts.view("l1")).not.toBeNull();
    // Fresh facts start nothing.
    const before = calls.length;
    facts.view("l1");
    await facts.settled();
    expect(calls).toHaveLength(before);
  });

  it("asks again once the facts are stale, and never for a lane that is not active", async () => {
    const { facts, calls, clock } = make({}, { rows: { gone: { state: "archived" } } });
    await facts.refresh("lane-1");
    const before = calls.length;
    await clock.advance(FACTS_STALE_MS - 1);
    facts.view("lane-1");
    await facts.settled();
    expect(calls).toHaveLength(before);
    await clock.advance(2);
    facts.view("lane-1");
    await facts.settled();
    expect(calls.length).toBeGreaterThan(before);
    const archivedBefore = calls.length;
    expect(facts.view("gone")).toBeNull();
    await facts.settled();
    expect(calls).toHaveLength(archivedBefore);
  });

  it("counts the dirty files now, for the archive refusal", async () => {
    const { facts } = make({ status: STATUS });
    await expect(facts.dirtyCount(row as unknown as LaneRow)).resolves.toBe(2);
  });
});
