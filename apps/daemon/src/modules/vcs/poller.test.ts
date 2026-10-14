import { PapError, type VcsStatus } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import type { LineCounter } from "./line-counts.ts";
import { createPoller, type Poller } from "./poller.ts";

const status = (root: string, at: number, over: Partial<VcsStatus> = {}): VcsStatus => ({
  root,
  repo: true,
  branch: "main",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  truncated: false,
  additions: 0,
  deletions: 0,
  at,
  error: null,
  ...over,
});

interface Run {
  readonly root: string;
  readonly counted: boolean;
}

let clock: FakeClock;
let watched: Set<string>;
let published: Array<{ stream: string; key: string; event: unknown }>;
let runs: Run[];
let answer: (root: string, run: number) => Promise<VcsStatus> | VcsStatus;
let poller: Poller;
let lines: Array<Record<string, unknown>>;

beforeEach(() => {
  clock = createFakeClock();
  watched = new Set();
  published = [];
  runs = [];
  answer = (root) => status(root, clock.now());
  const captured = captureLogger();
  lines = captured.lines;
  const counter: LineCounter = {
    beginRun: () => undefined,
    count: async () => ({ additions: null, binary: false }),
  };
  poller = createPoller({
    clock,
    logger: captured.logger,
    hub: {
      publish: (stream, key, event) => void published.push({ stream, key, event }),
      hasSubscribers: (_stream, key) => watched.has(key),
    },
    restrict: (given) => ({ ...given, files: given.files.filter((file) => file.path !== "secret") }),
    newCounter: () => counter,
    read: async (root, given) => {
      runs.push({ root, counted: given !== null });
      return answer(root, runs.length);
    },
  });
});

const settle = () => clock.advance(0);
const statusEvents = (root = "/r") => published.filter((p) => p.key === root).map((p) => p.event);

describe("polling", () => {
  it("runs every 15 s while the root has a subscriber", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    expect(runs).toHaveLength(1);
    await clock.advance(14_999);
    expect(runs).toHaveLength(1);
    await clock.advance(1);
    expect(runs).toHaveLength(2);
    await clock.advance(15_000);
    expect(runs).toHaveLength(3);
  });

  it("runs nothing once nobody listens, and arms nothing", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    watched.delete("/r");
    await clock.advance(15_000);
    expect(runs).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    await clock.advance(10 * 60_000);
    expect(runs).toHaveLength(1);
  });

  it("arms no poll for a refresh of a root nobody listens to", async () => {
    poller.refresh("/r");
    await settle();
    expect(runs).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    await clock.advance(60_000);
    expect(runs).toHaveLength(1);
  });

  it("a trigger during a run produces exactly one more run", async () => {
    watched.add("/r");
    let release: (value: VcsStatus) => void = () => undefined;
    answer = (root, run) =>
      run === 1 ? new Promise<VcsStatus>((resolve) => (release = resolve)) : status(root, clock.now());
    poller.watch("/r");
    await settle();
    poller.refresh("/r");
    poller.refresh("/r");
    poller.refresh("/r");
    expect(runs).toHaveLength(1);
    release(status("/r", clock.now()));
    await settle();
    expect(runs).toHaveLength(2);
    await settle();
    expect(runs).toHaveLength(2);
  });

  it("never runs two at once for one root, and runs two roots side by side", async () => {
    watched.add("/r");
    answer = () => new Promise<VcsStatus>(() => undefined);
    poller.watch("/r");
    poller.refresh("/r");
    poller.watch("/other");
    await settle();
    expect(runs.map((run) => run.root)).toEqual(["/r", "/other"]);
  });

  it("answers a subscription from the cache unless it is older than 2 s", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    expect(runs).toHaveLength(1);
    await clock.advance(1_999);
    poller.watch("/r");
    await settle();
    expect(runs).toHaveLength(1);
    await clock.advance(2);
    poller.watch("/r");
    await settle();
    expect(runs).toHaveLength(2);
  });

  it("a refresh runs whatever the age of the cache", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    poller.refresh("/r");
    await settle();
    expect(runs).toHaveLength(2);
  });

  it("arms the poll for a subscription that finds a fresh cache and no timer, before the subscription is open", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    watched.delete("/r");
    await clock.advance(15_000);
    expect(clock.pending()).toBe(0);
    poller.refresh("/r");
    await settle();
    expect(runs).toHaveLength(2);
    expect(clock.pending()).toBe(0);
    // `watch` runs before the handler opens the subscription: nobody is listed yet.
    poller.watch("/r");
    await settle();
    expect(runs).toHaveLength(2);
    expect(clock.pending()).toBe(1);
    watched.add("/r");
    await clock.advance(15_000);
    expect(runs).toHaveLength(3);
  });

  it("stop clears every timer", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    poller.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(60_000);
    expect(runs).toHaveLength(1);
  });
});

describe("what is published", () => {
  it("publishes the first status, nothing for an identical one with a new at, and one for a change", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    expect(statusEvents()).toHaveLength(1);
    await clock.advance(15_000);
    await clock.advance(15_000);
    expect(runs).toHaveLength(3);
    expect(statusEvents()).toHaveLength(1);
    answer = (root) => status(root, clock.now(), { branch: "dev" });
    await clock.advance(15_000);
    expect(statusEvents()).toHaveLength(2);
    expect(statusEvents()[1]).toEqual({
      kind: "status",
      status: status("/r", clock.now(), { branch: "dev" }),
    });
    await clock.advance(15_000);
    expect(statusEvents()).toHaveLength(2);
    expect(published.every((p) => p.stream === "vcs")).toBe(true);
  });

  it("keeps the newest run in the cache even when nothing was published for it", async () => {
    watched.add("/r");
    poller.watch("/r");
    await settle();
    const first = poller.snapshot("/r")?.at;
    await clock.advance(15_000);
    expect(poller.snapshot("/r")?.at).toBe((first ?? 0) + 15_000);
  });

  it("snapshots null for a root it has never read", () => {
    expect(poller.snapshot("/never")).toBeNull();
  });

  it("answers a read that throws with a failed status and logs it", async () => {
    watched.add("/r");
    answer = () => {
      throw new Error("boom");
    };
    poller.watch("/r");
    await settle();
    expect(poller.snapshot("/r")).toMatchObject({ root: "/r", repo: true, files: [], error: "failed" });
    expect(statusEvents()).toHaveLength(1);
    expect(lines.some((line) => line.msg === "vcs_read_failed")).toBe(true);
  });
});

describe("a timeout slows the poll down (M8R45)", () => {
  it("doubles the interval up to 5 minutes, reads no line counts meanwhile, and resets on a success", async () => {
    watched.add("/r");
    let failing = true;
    answer = (root) =>
      failing ? status(root, clock.now(), { error: "timeout", repo: true }) : status(root, clock.now());
    poller.watch("/r");
    await settle();
    expect(runs.map((r) => r.counted)).toEqual([true]);
    const gaps = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    for (const [index, gap] of gaps.entries()) {
      await clock.advance(gap - 1);
      expect(runs, `before gap ${index}`).toHaveLength(index + 1);
      await clock.advance(1);
      expect(runs, `after gap ${index}`).toHaveLength(index + 2);
    }
    expect(runs.slice(1).every((run) => !run.counted)).toBe(true);
    failing = false;
    await clock.advance(300_000);
    expect(runs.at(-1)?.counted).toBe(false);
    // The success came back: 15 s again, line counts back on.
    await clock.advance(15_000);
    expect(runs.at(-1)?.counted).toBe(true);
    expect(runs).toHaveLength(gaps.length + 3);
    await clock.advance(15_000);
    expect(runs).toHaveLength(gaps.length + 4);
  });

  it("leaves the interval alone for other errors", async () => {
    watched.add("/r");
    answer = (root) => status(root, clock.now(), { error: "failed" });
    poller.watch("/r");
    await settle();
    await clock.advance(15_000);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.counted).toBe(true);
  });
});

describe("the cache is bounded at 32 roots (M8R49)", () => {
  const rootOf = (i: number) => `/root${i}`;

  it("drops the oldest root nobody watches to admit a new one", async () => {
    for (let i = 0; i < 32; i += 1) {
      if (i !== 3) watched.add(rootOf(i));
      poller.watch(rootOf(i));
    }
    await settle();
    expect(poller.snapshot(rootOf(3))).not.toBeNull();
    watched.add(rootOf(32));
    poller.watch(rootOf(32));
    await settle();
    expect(poller.snapshot(rootOf(3))).toBeNull();
    expect(poller.snapshot(rootOf(0))).not.toBeNull();
    expect(poller.snapshot(rootOf(32))).not.toBeNull();
  });

  it("refuses a 33rd root while all 32 are watched, and never evicts a watched one", async () => {
    for (let i = 0; i < 32; i += 1) {
      watched.add(rootOf(i));
      poller.watch(rootOf(i));
    }
    await settle();
    expect(() => poller.watch(rootOf(32))).toThrow(PapError);
    expect(() => poller.refresh(rootOf(32))).toThrow(PapError);
    try {
      poller.watch(rootOf(32));
    } catch (error) {
      expect((error as PapError).code).toBe("capacity");
    }
    for (let i = 0; i < 32; i += 1) expect(poller.snapshot(rootOf(i))).not.toBeNull();
    // A root already cached is admitted again without a slot.
    expect(() => poller.watch(rootOf(5))).not.toThrow();
  });

  it("discards the result of a run that finishes after its root was dropped", async () => {
    let release: (value: VcsStatus) => void = () => undefined;
    answer = (root, run) =>
      run === 1 ? new Promise<VcsStatus>((resolve) => (release = resolve)) : status(root, clock.now());
    poller.watch("/first");
    for (let i = 0; i < 31; i += 1) {
      watched.add(rootOf(i));
      poller.watch(rootOf(i));
    }
    watched.add("/new");
    poller.watch("/new");
    release(status("/first", clock.now()));
    await settle();
    expect(poller.snapshot("/first")).toBeNull();
    expect(statusEvents("/first")).toEqual([]);
    expect(poller.snapshot("/new")).not.toBeNull();
  });
});

describe("the token view (MC24)", () => {
  const file = (path: string, additions = 1) => ({
    path,
    oldPath: null,
    folder: false,
    index: ".",
    worktree: "M",
    kind: "modified" as const,
    additions,
    deletions: 0,
    binary: false,
  });
  const tokenEvents = () =>
    published.filter((p) => p.key === "token:/r").map((p) => p.event as { status: VcsStatus });

  it("publishes a filtered status on its own key only while a token listens", async () => {
    watched.add("/r");
    answer = (root) => status(root, clock.now(), { files: [file("secret"), file("ok")] });
    poller.watch("/r");
    await settle();
    expect(tokenEvents()).toEqual([]);
    expect((statusEvents()[0] as { status: VcsStatus }).status.files.map((f) => f.path)).toEqual([
      "secret",
      "ok",
    ]);
    watched.add("token:/r");
    poller.refresh("/r");
    await settle();
    expect(tokenEvents().map((e) => e.status.files.map((f) => f.path))).toEqual([["ok"]]);
  });

  it("publishes nothing to the token when only a refused file changed", async () => {
    watched.add("/r");
    watched.add("token:/r");
    let secretLines = 1;
    answer = (root) => status(root, clock.now(), { files: [file("secret", secretLines), file("ok")] });
    poller.watch("/r");
    await settle();
    secretLines = 2;
    await clock.advance(15_000);
    expect(statusEvents()).toHaveLength(2);
    expect(tokenEvents()).toHaveLength(1);
  });

  it("snapshots the filtered status under the token key and the full one under the root", async () => {
    watched.add("/r");
    answer = (root) => status(root, clock.now(), { files: [file("secret"), file("ok")] });
    poller.watch("/r");
    await settle();
    expect(poller.snapshot("/r")?.files.map((f) => f.path)).toEqual(["secret", "ok"]);
    expect(poller.snapshot("token:/r")?.files.map((f) => f.path)).toEqual(["ok"]);
    expect(poller.snapshot("token:/never")).toBeNull();
  });

  it("keeps the poll going for a root only a token listens to", async () => {
    watched.add("token:/r");
    poller.watch("/r");
    await settle();
    await clock.advance(15_000);
    expect(runs).toHaveLength(2);
  });
});
