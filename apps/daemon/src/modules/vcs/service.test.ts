import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HandlerContext, PapError, type StreamName, type VcsStatus } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createVcsModule } from "./index.ts";
import { createVcsBed, fakeGit, type VcsBed } from "./testing/vcs-bed.ts";

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

function setup(options: { git?: ReturnType<typeof fakeGit>["git"]; roots?: readonly string[] } = {}) {
  const published: Array<{ key: string; event: { kind: string; status: VcsStatus } }> = [];
  const snapshots = new Map<StreamName, (key: string) => unknown>();
  const opened: Array<[StreamName, string, unknown]> = [];
  const module = createVcsModule({
    roots: (ownerId) => (ownerId === "u1" ? (options.roots ?? [bed.repo]) : []),
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: options.git ?? bed.git,
    hub: {
      registerSnapshot: (stream, provider) => void snapshots.set(stream, provider),
      publish: (_stream, key, event) => void published.push({ key, event: event as never }),
      hasSubscribers: (stream, key) => opened.some(([s, k]) => s === stream && k === key),
    },
    clock: bed.clock,
    logger: bed.logger,
  });
  stop = () => module.shutdown();
  const ctx = (overrides: Partial<HandlerContext["caller"]> = {}): HandlerContext => ({
    caller: testCaller(overrides),
    connectionId: "c1",
    openSubscription: (stream, key, after) => {
      opened.push([stream, key, after]);
      return "s1";
    },
    closeSubscription: () => undefined,
  });
  return { module, published, snapshots, opened, ctx };
}
const code = async (run: Promise<unknown>) => ((await run.catch((e: unknown) => e)) as PapError).code;

describe("which roots can be watched (M8R44)", () => {
  it("opens the stream for one of the caller's roots, with the cursor, and answers the sub", async () => {
    const { module, opened, ctx } = setup();
    const after = { epoch: "e", seq: 3 };
    expect(await module.rpc["subscribe.vcs"]({ root: bed.repo, after }, ctx())).toEqual({ sub: "s1" });
    expect(opened).toEqual([["vcs", bed.repo, after]]);
  });

  it("answers not_found, opens nothing and runs no git for a subfolder, another owner's root, home or pap home", async () => {
    const { git, calls } = fakeGit(() => "");
    const { module, opened, ctx } = setup({ git, roots: [bed.repo, bed.bb.papHome] });
    mkdirSync(join(bed.repo, "sub"));
    const attempts: Array<[string, Partial<HandlerContext["caller"]>]> = [
      [join(bed.repo, "sub"), {}],
      [bed.repo, { userId: "u2" }],
      [bed.bb.home, {}],
      [bed.bb.papHome, {}],
      [`${bed.repo}-other`, {}],
    ];
    for (const [root, caller] of attempts) {
      expect(await code(module.rpc["subscribe.vcs"]({ root }, ctx(caller))), root).toBe("not_found");
      expect(await code(module.rpc["vcs.refresh"]({ root }, ctx(caller))), root).toBe("not_found");
      const params = { root, path: "a.txt", from: { kind: "head" }, to: { kind: "head" } } as const;
      expect(await code(module.rpc["vcs.fileDiff"](params, ctx(caller))), root).toBe("not_found");
    }
    expect(opened).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("what a token may see of a status (MC24)", () => {
  const git = (...args: string[]) => bed.gb.git(bed.repo, ...args);
  /** A tracked `.mcp.json` edited, a tracked `.pi/mcp.json` renamed to a visible name, an untracked `.mcp.local`... and plain files. */
  function plant(): void {
    mkdirSync(join(bed.repo, ".pi"));
    writeFileSync(join(bed.repo, ".mcp.json"), "{}\n");
    writeFileSync(join(bed.repo, ".pi", "mcp.json"), "{}\n");
    git("add", ".mcp.json", ".pi/mcp.json");
    git("commit", "-q", "-m", "hidden");
    writeFileSync(join(bed.repo, ".mcp.json"), "{}\n{}\n{}\n");
    git("mv", ".pi/mcp.json", "moved.json");
    writeFileSync(join(bed.repo, "n.txt"), "x\ny\n");
    writeFileSync(join(bed.repo, "a.txt"), "one\ntwo\n");
  }
  const paths = (event: { status: VcsStatus }) => event.status.files.map((f) => f.path).sort();

  it("shows the owner every file with real counts, hidden ones included", async () => {
    plant();
    const { module, published, ctx } = setup();
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx());
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 10_000 });
    const status = published[0]?.event.status as VcsStatus;
    expect(status.files.map((f) => [f.path, f.oldPath, f.additions, f.deletions]).sort()).toEqual([
      [".mcp.json", null, 2, 0],
      ["a.txt", null, 1, 0],
      ["moved.json", ".pi/mcp.json", 0, 0],
      ["n.txt", null, 2, 0],
    ]);
    expect([status.additions, status.deletions]).toEqual([5, 0]);
  });

  it("gives a token its own stream, without a path or an old path its boundary refuses, and totals of what is left", async () => {
    plant();
    const { module, published, opened, ctx } = setup();
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx({ kind: "token" }));
    expect(opened.map(([, key]) => key)).toEqual([`token:${bed.repo}`]);
    await vi.waitFor(() => expect(published.some((p) => p.key === `token:${bed.repo}`)).toBe(true), {
      timeout: 10_000,
    });
    const event = published.find((p) => p.key === `token:${bed.repo}`)?.event as { status: VcsStatus };
    expect(paths(event)).toEqual(["a.txt", "n.txt"]);
    expect([event.status.additions, event.status.deletions]).toEqual([3, 0]);
    expect(JSON.stringify(event)).not.toContain("mcp");
  });

  it("keeps the two views apart when both watch, and a token's snapshot is filtered too", async () => {
    plant();
    const { module, published, snapshots, ctx } = setup();
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx());
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx({ kind: "token" }));
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 10_000 });
    expect(published.map((p) => p.key).sort()).toEqual([bed.repo, `token:${bed.repo}`].sort());
    const snapshot = snapshots.get("vcs");
    const owner = snapshot?.(bed.repo) as { status: VcsStatus };
    const token = snapshot?.(`token:${bed.repo}`) as { status: VcsStatus };
    expect(paths(owner)).toEqual([".mcp.json", "a.txt", "moved.json", "n.txt"]);
    expect(paths(token)).toEqual(["a.txt", "n.txt"]);
  });
});

describe("untracked links are never counted (MC25)", () => {
  it("shows no count for a link to a token-hidden file, to the token or the owner, and still counts a regular file", async () => {
    writeFileSync(join(bed.repo, ".mcp.json"), "1\n2\n3\n4\n5\n6\n7\n");
    symlinkSync(".mcp.json", join(bed.repo, "innocent"));
    writeFileSync(join(bed.repo, "plain.txt"), "x\ny\n");
    const { module, published, ctx } = setup();
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx());
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx({ kind: "token" }));
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 10_000 });
    for (const { event } of published) {
      const counts = new Map(event.status.files.map((f) => [f.path, f.additions]));
      expect(counts.get("innocent"), JSON.stringify(event)).toBeNull();
      expect(counts.get("plain.txt")).toBe(2);
    }
  });
});

describe("snapshot and refresh (M8R48)", () => {
  it("snapshots null before a status exists, starts the refresh, and publishes its result as a status event", async () => {
    const { module, snapshots, published, ctx } = setup();
    const snapshot = snapshots.get("vcs");
    expect(snapshot?.(bed.repo)).toEqual({ kind: "snapshot", status: null });
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx());
    expect(published).toEqual([]);
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 10_000 });
    expect(published[0]?.event).toMatchObject({
      kind: "status",
      status: { root: bed.repo, repo: true, branch: "main", files: [], error: null },
    });
    expect(snapshot?.(bed.repo)).toEqual({ kind: "snapshot", status: published[0]?.event.status });
  });

  it("vcs.refresh answers ok at once and a change on disk arrives as a new status event", async () => {
    const { module, published, ctx } = setup();
    await module.rpc["subscribe.vcs"]({ root: bed.repo }, ctx());
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 10_000 });
    writeFileSync(join(bed.repo, "a.txt"), "one\ntwo\n");
    expect(await module.rpc["vcs.refresh"]({ root: bed.repo }, ctx())).toEqual({ ok: true });
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 10_000 });
    expect(published[1]?.event.status.files).toMatchObject([
      { path: "a.txt", kind: "modified", additions: 1, deletions: 0 },
    ]);
  });
});
