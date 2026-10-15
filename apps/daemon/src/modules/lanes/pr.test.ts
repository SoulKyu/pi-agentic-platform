import { type ForgeKind, LANE_LIMITS, type PrView } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { ForgeResult } from "../../kernel/forge/cli.ts";
import type { Forge } from "../../kernel/forge/port.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createMutex } from "./push.ts";
import { baseBranchOf, createPrs, type PrDeps } from "./pr.ts";
import type { RemoteInfo } from "./remote-facts.ts";
import type { LaneRow } from "./store.ts";

const NOW = 1_700_000_000_000;
const REPO = { host: "github.com", path: "o/r" };
const prOf = (over: Partial<PrView> = {}): PrView => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: false,
  conflicts: false,
  checks: { total: 3, passed: 2, failed: 0, pending: 1 },
  checkedAt: NOW,
  error: null,
  ...over,
});
const ok = <T>(value: T): ForgeResult<T> => ({ ok: true, value });
const fail = (outcome: Extract<ForgeResult<never>, { ok: false }>["outcome"]): ForgeResult<never> => ({
  ok: false,
  outcome,
});

interface Script {
  find?: Array<ForgeResult<PrView | null> | Error>;
  create?: Array<ForgeResult<PrView> | Error>;
  view?: Array<ForgeResult<PrView> | Error>;
}
function fakeForge(script: Script) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const next = <T>(op: keyof Script, queue: Array<T | Error> | undefined, args: unknown[]): T => {
    calls.push({ op, args });
    const item = queue?.shift();
    if (item === undefined) throw new Error(`no scripted ${op}`);
    if (item instanceof Error) throw item;
    return item;
  };
  const forge: Forge = {
    kind: "github",
    findPr: async (repo, head) => next("find", script.find, [repo, head]),
    createPr: async (repo, input) => next("create", script.create, [repo, input]),
    viewPr: async (repo, number) => next("view", script.view, [repo, number]),
    viewIssue: async () => {
      throw new Error("unused");
    },
  };
  return { forge, calls };
}

interface Over {
  unpushed?: number | null;
  info?: Partial<RemoteInfo>;
  row?: Partial<LaneRow>;
  readOnly?: boolean;
  noForge?: boolean;
}
function make(script: Script, over: Over = {}) {
  const { forge, calls } = fakeForge(script);
  const clock = createFakeClock(NOW);
  let unpushed: number | null = over.unpushed === undefined ? 1 : over.unpushed;
  let lane = {
    id: "lane-1",
    ownerId: "u1",
    branch: "pi/x",
    baseRef: "refs/remotes/origin/main",
    state: "active",
    prNumber: null,
    prUrl: null,
    ...over.row,
  } as LaneRow;
  const info: RemoteInfo = { remote: REPO, pushRemote: REPO, forge: "github" as ForgeKind, ...over.info };
  const setPr = vi.fn((_id: string, number: number, url: string) => {
    lane = { ...lane, prNumber: number, prUrl: url };
  });
  const audited: Array<Parameters<PrDeps["audit"]["append"]>[0]> = [];
  const publish = vi.fn();
  const factsRefresh = vi.fn(async () => undefined);
  const remoteRefresh = vi.fn(async () => undefined);
  const prs = createPrs({
    store: { getOwned: (owner, id) => (owner === "u1" && id === "lane-1" ? lane : undefined), setPr },
    forgeFor: (kind) => (kind === "github" && !over.noForge ? forge : null),
    facts: {
      get: () => ({ unpushed }) as never,
      refresh: factsRefresh,
    },
    remote: { get: () => info, refresh: remoteRefresh },
    mutex: createMutex(),
    audit: { append: (line) => void audited.push(line) },
    clock,
    logger: silentLogger,
    publish,
    readOnly: over.readOnly ?? false,
  });
  return {
    prs,
    audited,
    calls,
    clock,
    setPr,
    publish,
    factsRefresh,
    remoteRefresh,
    lane: () => lane,
    setUnpushed: (value: number | null) => void (unpushed = value),
  };
}
const create = (m: ReturnType<typeof make>, over: { title?: string; draft?: boolean } = {}) =>
  m.prs.prCreate(testCaller(), {
    laneId: "lane-1",
    title: over.title ?? "T",
    body: "B",
    draft: over.draft ?? false,
  });
const refresh = (m: ReturnType<typeof make>) => m.prs.prRefresh(testCaller(), { laneId: "lane-1" });

describe("baseBranchOf", () => {
  it("names the branch of a local or remote-tracking base, and none for a commit", () => {
    expect(baseBranchOf("refs/heads/main")).toBe("main");
    expect(baseBranchOf("refs/remotes/origin/main")).toBe("main");
    expect(baseBranchOf("refs/remotes/upstream/feature/x")).toBe("feature/x");
    expect(baseBranchOf("a".repeat(40))).toBeUndefined();
    expect(baseBranchOf("main")).toBeUndefined();
  });
});

describe("lanes.prCreate", () => {
  it("uses the lane's stored description as the body when the client sends an empty one", async () => {
    const m = make(
      { find: [ok(null)], create: [ok(prOf())], view: [ok(prOf())] },
      { row: { description: "the lane's words" } },
    );
    await m.prs.prCreate(testCaller(), { laneId: "lane-1", title: "T", body: "  ", draft: false });
    expect(m.calls.find((call) => call.op === "create")?.args[1]).toMatchObject({ body: "the lane's words" });
  });

  it("keeps a body the client sent, and clips whatever goes out to the contract's cap", async () => {
    const sent = make(
      { find: [ok(null)], create: [ok(prOf())], view: [ok(prOf())] },
      { row: { description: "d" } },
    );
    await create(sent);
    expect(sent.calls.find((call) => call.op === "create")?.args[1]).toMatchObject({ body: "B" });
    const long = make(
      { find: [ok(null)], create: [ok(prOf())], view: [ok(prOf())] },
      { row: { description: "x".repeat(LANE_LIMITS.prBody + 5) } },
    );
    await long.prs.prCreate(testCaller(), { laneId: "lane-1", title: "T", body: "", draft: false });
    const body = (long.calls.find((call) => call.op === "create")?.args[1] as { body: string }).body;
    expect(body).toHaveLength(LANE_LIMITS.prBody);
  });

  it("answers not_pushed before any forge call when there is no upstream", async () => {
    const m = make({}, { unpushed: null });
    expect(await create(m)).toEqual({ ok: false, reason: "not_pushed" });
    expect(m.calls).toEqual([]);
  });

  it("creates with head = the branch and base = the base ref's branch, then views it and stores the number", async () => {
    const created = prOf({ checks: null, conflicts: null });
    const m = make({ find: [ok(null)], create: [ok(created)], view: [ok(prOf())] });
    expect(await create(m, { draft: true })).toEqual({ ok: true, pr: prOf() });
    expect(m.calls.map((call) => call.op)).toEqual(["find", "create", "view"]);
    expect(m.calls[1]?.args).toEqual([
      REPO,
      { head: "pi/x", base: "main", title: "T", body: "B", draft: true },
    ]);
    expect(m.setPr).toHaveBeenCalledWith("lane-1", 7, "https://github.com/o/r/pull/7");
    expect(m.publish).toHaveBeenCalledWith("lane-1");
  });

  it("audits a pull request it made: the repository and the number, never the title or the body; none for a reused one (M13)", async () => {
    const m = make({ find: [ok(null)], create: [ok(prOf())], view: [ok(prOf())] });
    await create(m, { draft: true, title: "secret title" });
    expect(m.audited).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "lane_pr_created",
        detail: { laneId: "lane-1", host: REPO.host, path: REPO.path, number: 7, draft: true },
      },
    ]);
    expect(JSON.stringify(m.audited)).not.toContain("secret title");
    const reused = make({ find: [ok(prOf())], view: [ok(prOf())] });
    await create(reused);
    expect(reused.audited).toEqual([]);
  });

  it("sends no base for a commit base", async () => {
    const m = make(
      { find: [ok(null)], create: [ok(prOf())], view: [ok(prOf())] },
      { row: { baseRef: "a".repeat(40) } },
    );
    await create(m);
    expect(m.calls[1]?.args[1]).toEqual({ head: "pi/x", title: "T", body: "B", draft: false });
  });

  it("reuses an open pull request of the branch: no second one is created", async () => {
    const m = make({ find: [ok(prOf())], view: [ok(prOf({ checks: null }))] });
    expect(await create(m)).toMatchObject({ ok: true, pr: { number: 7 } });
    expect(m.calls.map((call) => call.op)).toEqual(["find", "view"]);
    expect(m.setPr).toHaveBeenCalledWith("lane-1", 7, "https://github.com/o/r/pull/7");
  });

  it("creates a new one when the branch's pull request is closed or merged", async () => {
    const m = make({
      find: [ok(prOf({ state: "merged" }))],
      create: [ok(prOf({ number: 9 }))],
      view: [ok(prOf({ number: 9 }))],
    });
    expect(await create(m)).toMatchObject({ ok: true, pr: { number: 9 } });
    expect(m.calls.map((call) => call.op)).toEqual(["find", "create", "view"]);
  });

  it("keeps the created pull request when the view after it fails", async () => {
    const m = make({ find: [ok(null)], create: [ok(prOf({ checks: null }))], view: [fail("timeout")] });
    expect(await create(m)).toMatchObject({ ok: true, pr: { number: 7, error: null } });
  });

  it("answers unsupported_remote for a forge without an adapter, or without a remote", async () => {
    expect(await create(make({}, { info: { forge: "gitea" }, noForge: true }))).toEqual({
      ok: false,
      reason: "unsupported_remote",
    });
    expect(await create(make({}, { info: { remote: null, forge: null } }))).toEqual({
      ok: false,
      reason: "unsupported_remote",
    });
  });

  it("maps the CLI's own outcomes", async () => {
    expect(await create(make({ find: [fail("forge_missing")] }))).toEqual({
      ok: false,
      reason: "forge_missing",
    });
    expect(await create(make({ find: [fail("not_signed_in")] }))).toEqual({
      ok: false,
      reason: "not_signed_in",
    });
    expect(await create(make({ find: [ok(null)], create: [fail("not_signed_in")] }))).toEqual({
      ok: false,
      reason: "not_signed_in",
    });
    expect(await create(make({ find: [ok(null)], create: [fail("not_found")] }))).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("reads that time out are failed (idempotent: a retry is safe)", async () => {
    for (const outcome of ["timeout", "too_large"] as const) {
      const m = make({ find: [fail(outcome)] });
      expect(await create(m)).toEqual({ ok: false, reason: "failed" });
      expect(m.calls.map((call) => call.op)).toEqual(["find"]);
    }
  });

  it("answers the timeout error when the creation times out: the outcome is unknown, never failed", async () => {
    for (const outcome of ["timeout", "too_large"] as const) {
      const m = make({ find: [ok(null)], create: [fail(outcome)] });
      await expect(create(m)).rejects.toMatchObject({ code: "timeout" });
      expect(m.setPr).not.toHaveBeenCalled();
    }
  });

  it("answers failed when an argument is refused before the CLI starts", async () => {
    const m = make({ find: [new Error("forge argument refused")] });
    expect(await create(m)).toEqual({ ok: false, reason: "failed" });
  });

  it("is the caller's own, writable and active lane", async () => {
    await expect(
      make({}).prs.prCreate(testCaller({ userId: "u2" }), {
        laneId: "lane-1",
        title: "T",
        body: "",
        draft: false,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(create(make({}, { readOnly: true }))).rejects.toMatchObject({ code: "read_only" });
    expect(await create(make({}, { row: { state: "archived" } }))).toEqual({ ok: false, reason: "failed" });
  });
});

describe("lanes.prRefresh", () => {
  const stored = { prNumber: 7, prUrl: "https://github.com/o/r/pull/7" };

  it("answers null for a lane that was never pushed, without a forge call", async () => {
    const m = make({}, { unpushed: null });
    expect(await refresh(m)).toEqual({ pr: null });
    expect(m.calls).toEqual([]);
  });

  it("views the stored pull request, caches it for 60 s and asks again after", async () => {
    const m = make(
      { view: [ok(prOf()), ok(prOf({ checks: { total: 3, passed: 3, failed: 0, pending: 0 } }))] },
      { row: stored },
    );
    expect(await refresh(m)).toEqual({ pr: prOf() });
    await m.clock.advance(59_000);
    expect(await refresh(m)).toEqual({ pr: prOf() });
    expect(m.calls).toHaveLength(1);
    await m.clock.advance(1_001);
    expect(await refresh(m)).toMatchObject({ pr: { checks: { passed: 3 } } });
    expect(m.calls).toHaveLength(2);
  });

  it("keeps the last state and sets the error when the forge fails, and tries again next time", async () => {
    const m = make({ view: [ok(prOf()), fail("not_signed_in"), ok(prOf())] }, { row: stored });
    await refresh(m);
    await m.clock.advance(61_000);
    expect(await refresh(m)).toEqual({ pr: prOf({ error: "not_signed_in" }) });
    expect(await refresh(m)).toEqual({ pr: prOf() });
    expect(m.calls).toHaveLength(3);
  });

  it("answers the stored number and URL with an unknown state after a restart, and the error when the forge is down", async () => {
    const m = make({ view: [fail("timeout")] }, { row: stored });
    expect(await refresh(m)).toEqual({
      pr: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: null,
        draft: false,
        conflicts: null,
        checks: null,
        checkedAt: null,
        error: "failed",
      },
    });
  });

  it("finds the pull request of a pushed lane that has none stored, and stores it", async () => {
    const m = make({ find: [ok(prOf())] });
    expect(await refresh(m)).toEqual({ pr: prOf() });
    expect(m.setPr).toHaveBeenCalledWith("lane-1", 7, "https://github.com/o/r/pull/7");
    await refresh(m);
    expect(m.calls).toHaveLength(1);
  });

  it("reconciles after a creation that timed out, even when the facts no longer show a push: the forge's pull request is found", async () => {
    const m = make({ find: [ok(null), ok(prOf())], create: [fail("timeout")] });
    await expect(create(m)).rejects.toMatchObject({ code: "timeout" });
    m.setUnpushed(null);
    expect(await refresh(m)).toEqual({ pr: prOf() });
    expect(m.calls.map((call) => call.op)).toEqual(["find", "create", "find"]);
    expect(m.setPr).toHaveBeenCalledWith("lane-1", 7, "https://github.com/o/r/pull/7");
  });

  it("keeps reconciling while the forge cannot answer, and stops once it has", async () => {
    const m = make({ find: [ok(null), fail("timeout"), ok(null)], create: [fail("timeout")] });
    await expect(create(m)).rejects.toMatchObject({ code: "timeout" });
    m.setUnpushed(null);
    expect(await refresh(m)).toEqual({ pr: null });
    expect(await refresh(m)).toEqual({ pr: null });
    await m.clock.advance(61_000);
    expect(await refresh(m)).toEqual({ pr: null });
    expect(m.calls.map((call) => call.op)).toEqual(["find", "create", "find", "find"]);
  });

  it("writes nothing on a read-only daemon: a reconcile answers from the forge and keeps the pull request in memory", async () => {
    const m = make({ find: [ok(prOf())] }, { readOnly: true });
    expect(await refresh(m)).toEqual({ pr: prOf() });
    expect(m.setPr).not.toHaveBeenCalled();
    expect(m.prs.viewFor(m.lane())).toEqual(prOf());
  });

  it("answers null for an archived lane without a stored pull request, and is the caller's own", async () => {
    expect(await refresh(make({}, { row: { state: "archived" } }))).toEqual({ pr: null });
    await expect(
      make({}).prs.prRefresh(testCaller({ userId: "u2" }), { laneId: "lane-1" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the lane view's pull request", () => {
  it("is null without a pull request and the stored number and URL otherwise", () => {
    expect(make({}).prs.viewFor(make({}).lane())).toBeNull();
    const m = make({}, { row: { prNumber: 7, prUrl: "https://github.com/o/r/pull/7" } });
    expect(m.prs.viewFor(m.lane())).toMatchObject({ number: 7, state: null, checkedAt: null });
  });
});
