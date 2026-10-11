import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type RpcErrorCode } from "../runtime/index.ts";
import { reportClientIssue } from "./report.ts";
import { createAccountDocument, loadSetting, type AccountStatus } from "./account-setting.ts";

type Doc = { readonly a: string; readonly b: string };
vi.mock("./report.ts", () => ({ reportClientIssue: vi.fn() }));
const EMPTY: Doc = { a: "", b: "" };

function manualTimers() {
  let next = 0;
  const due = new Map<number, () => void>();
  return {
    set: (fn: () => void) => (due.set(++next, fn), next),
    clear: (id: number) => void due.delete(id),
    fire: () => [...due.entries()].forEach(([id, fn]) => (due.delete(id), fn())),
    pending: () => due.size,
  };
}

// The fake server answers at once; this lets its promises and the document's follow-ups settle. Not a sleep.
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type Step = () => unknown;
const loaded =
  (value: unknown, revision: number): Step =>
  () => ({ value, revision });
const saved =
  (revision: number): Step =>
  () => ({ revision });
const fails =
  (code: RpcErrorCode): Step =>
  () => {
    throw new RpcError(code);
  };

/** Answers settings.get and settings.set from scripted steps and records every call. */
function fakeServer(get: Step[], set: Step[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const step = (method === "settings.get" ? get : set).shift();
    if (!step) return new Promise(() => {}); // script exhausted: park, so a surplus call shows in the counts
    return step();
  });
  return {
    rpc: { call } as never,
    calls,
    sets: () => calls.filter((c) => c.method === "settings.set").map((c) => c.params),
  };
}

function harness(initial: Doc = EMPTY) {
  let state = initial;
  const statuses: AccountStatus[] = [];
  const timers = manualTimers();
  const doc = createAccountDocument<Doc>({
    key: "appearance",
    write: (value, baseRevision) => ({ key: "appearance", value, baseRevision }) as never,
    parse: (value) => ({ ...EMPTY, ...(value as Partial<Doc>) }),
    changed: (previous, next) => (["a", "b"] as const).filter((name) => previous[name] !== next[name]),
    merge: (server, local, dirty) => ({
      a: dirty.has("a") ? local.a : server.a,
      b: dirty.has("b") ? local.b : server.b,
    }),
    local: () => state,
    adopt: (value) => {
      state = value;
    },
    onStatus: (status) => statuses.push(status),
    timers,
  });
  const edit = (next: Partial<Doc>) => {
    const previous = state;
    state = { ...state, ...next };
    doc.change(previous, state);
  };
  return { doc, edit, timers, statuses, state: () => state };
}

beforeEach(() => vi.mocked(reportClientIssue).mockClear());

describe("loadSetting", () => {
  it("tells loaded, unsupported (older daemon) and failed apart", async () => {
    expect(
      await loadSetting(
        { call: vi.fn().mockResolvedValue({ value: { a: 1 }, revision: 2 }) } as never,
        "appearance",
      ),
    ).toEqual({ kind: "loaded", value: { a: 1 }, revision: 2 });
    expect(
      await loadSetting(
        { call: vi.fn().mockRejectedValue(new RpcError("unknown_method")) } as never,
        "appearance",
      ),
    ).toEqual({ kind: "unsupported" });
    expect(
      await loadSetting(
        { call: vi.fn().mockRejectedValue(new RpcError("connection_lost")) } as never,
        "appearance",
      ),
    ).toEqual({ kind: "failed", code: "connection_lost" });
    expect(
      await loadSetting({ call: vi.fn().mockRejectedValue(new Error("boom")) } as never, "appearance"),
    ).toEqual({ kind: "failed", code: "internal" });
  });
});

describe("account document (compare-and-set, owner R3-4)", () => {
  it("holds a change made before the first load, then sends it on top of the server copy", async () => {
    const h = harness();
    h.edit({ a: "mine" });
    h.timers.fire();
    const server = fakeServer([loaded({ a: "theirs", b: "server" }, 3)], [saved(4)]);
    await h.doc.sync(server.rpc);
    await drain();
    expect(h.state()).toEqual({ a: "mine", b: "server" });
    expect(server.sets()).toEqual([
      { key: "appearance", value: { a: "mine", b: "server" }, baseRevision: 3 },
    ]);
    expect(h.statuses.at(-1)).toBe("saved");
  });

  it("never saves after a failed load; the next successful sync sends the change", async () => {
    const h = harness();
    const down = fakeServer([fails("connection_lost")], []);
    await h.doc.sync(down.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([down.sets(), h.statuses.at(-1)]).toEqual([[], "load-error"]);
    expect(reportClientIssue).toHaveBeenCalledWith("setting_load_failed");
    const up = fakeServer([loaded({ a: "", b: "server" }, 2)], [saved(3)]);
    await h.doc.sync(up.rpc);
    await drain();
    expect(up.sets()).toEqual([{ key: "appearance", value: { a: "mine", b: "server" }, baseRevision: 2 }]);
  });

  it("answers a conflict with a re-read, a merge and one retry", async () => {
    const h = harness();
    const server = fakeServer(
      [loaded({ a: "", b: "" }, 1), loaded({ a: "", b: "other device" }, 2)],
      [fails("conflict"), saved(3)],
    );
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect(server.sets()).toEqual([
      { key: "appearance", value: { a: "mine", b: "" }, baseRevision: 1 },
      { key: "appearance", value: { a: "mine", b: "other device" }, baseRevision: 2 },
    ]);
    expect([h.state(), h.statuses.at(-1)]).toEqual([{ a: "mine", b: "other device" }, "saved"]);
  });

  it("reports a second conflict and waits for the next change", async () => {
    const h = harness();
    const server = fakeServer([loaded({}, 1), loaded({}, 2)], [fails("conflict"), fails("conflict")]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([server.sets().length, h.statuses.at(-1), h.timers.pending()]).toEqual([2, "error", 0]);
  });

  it("does not re-send a failed save by itself (R105); the next change sends it", async () => {
    const h = harness();
    const server = fakeServer([loaded({}, 1)], [fails("connection_lost"), saved(2)]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([server.sets().length, h.statuses.at(-1), h.timers.pending()]).toEqual([1, "error", 0]);
    expect(reportClientIssue).toHaveBeenCalledWith("setting_save_failed");
    h.edit({ b: "more" });
    h.timers.fire();
    await drain();
    expect(server.sets().at(-1)).toEqual({
      key: "appearance",
      value: { a: "mine", b: "more" },
      baseRevision: 1,
    });
  });

  it("sends one save at a time; a change made meanwhile goes out after it, from the new revision", async () => {
    const h = harness();
    let answer: (value: unknown) => void = () => {};
    const server = fakeServer(
      [loaded({}, 1)],
      [() => new Promise((resolve) => (answer = resolve)), saved(3)],
    );
    await h.doc.sync(server.rpc);
    h.edit({ a: "one" });
    h.timers.fire();
    await drain();
    h.edit({ b: "two" });
    h.timers.fire();
    await drain();
    expect(server.sets()).toHaveLength(1);
    answer({ revision: 2 });
    await drain();
    expect(server.sets().at(-1)).toEqual({
      key: "appearance",
      value: { a: "one", b: "two" },
      baseRevision: 2,
    });
  });

  it("keeps a waiting change across a re-sync and sends it after the reload", async () => {
    const h = harness();
    const first = fakeServer([loaded({}, 1)], []);
    await h.doc.sync(first.rpc);
    h.edit({ a: "mine" });
    expect(h.timers.pending()).toBe(1);
    const second = fakeServer([loaded({ b: "server" }, 5)], [saved(6)]);
    await h.doc.sync(second.rpc);
    await drain();
    expect([first.sets(), second.sets()]).toEqual([
      [],
      [{ key: "appearance", value: { a: "mine", b: "server" }, baseRevision: 5 }],
    ]);
    expect(h.timers.pending()).toBe(0);
  });

  it("drops the answer of an older sync", async () => {
    const h = harness();
    let late: (value: unknown) => void = () => {};
    const slow = fakeServer([() => new Promise((resolve) => (late = resolve))], []);
    const pending = h.doc.sync(slow.rpc);
    await h.doc.sync(fakeServer([loaded({ b: "new" }, 7)], []).rpc);
    late({ value: { b: "old" }, revision: 6 });
    await pending;
    expect(h.state()).toEqual({ a: "", b: "new" });
  });

  it("sends nothing to an older daemon, and nothing without a change", async () => {
    const h = harness();
    const old = fakeServer([fails("unknown_method")], []);
    await h.doc.sync(old.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([old.sets(), h.statuses.at(-1)]).toEqual([[], "local"]);
    const quiet = harness();
    const empty = fakeServer([loaded(null, 0)], []);
    await quiet.doc.sync(empty.rpc);
    expect([empty.sets(), quiet.statuses.at(-1)]).toEqual([[], "local"]);
  });

  it("saves over a damaged row with its revision as baseRevision, never 0", async () => {
    const h = harness();
    const server = fakeServer([loaded(null, 4)], [saved(5)]);
    await h.doc.sync(server.rpc);
    expect(h.statuses.at(-1)).toBe("local");
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect(server.sets()).toEqual([{ key: "appearance", value: { a: "mine", b: "" }, baseRevision: 4 }]);
  });

  it("treats a timeout as outcome unknown: not re-sent by itself, the next change re-reads on conflict", async () => {
    const h = harness();
    const server = fakeServer(
      [loaded({}, 1), loaded({ b: "landed" }, 2)],
      [fails("timeout"), fails("conflict"), saved(3)],
    );
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([server.sets().length, h.statuses.at(-1), h.timers.pending()]).toEqual([1, "error", 0]);
    h.edit({ a: "mine 2" });
    h.timers.fire();
    await drain();
    expect(server.sets().at(-1)).toEqual({
      key: "appearance",
      value: { a: "mine 2", b: "landed" },
      baseRevision: 2,
    });
    expect(h.statuses.at(-1)).toBe("saved");
  });

  it("sends nothing when the reload after a conflict fails, and sends the change after a later sync", async () => {
    const h = harness();
    const server = fakeServer([loaded({}, 1), fails("connection_lost")], [fails("conflict")]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([server.sets().length, h.statuses.at(-1)]).toEqual([1, "load-error"]);
    h.edit({ b: "more" });
    h.timers.fire();
    await drain();
    expect(server.sets()).toHaveLength(1);
    const later = fakeServer([loaded({ a: "x", b: "y" }, 9)], [saved(10)]);
    await h.doc.sync(later.rpc);
    await drain();
    expect(later.sets()).toEqual([{ key: "appearance", value: { a: "mine", b: "more" }, baseRevision: 9 }]);
  });

  it("flushes a save waiting behind an in-flight save when a re-sync arrives, from the reloaded revision", async () => {
    const h = harness();
    let answer: (value: unknown) => void = () => {};
    const first = fakeServer([loaded({}, 1)], [() => new Promise((resolve) => (answer = resolve))]);
    await h.doc.sync(first.rpc);
    h.edit({ a: "one" });
    h.timers.fire();
    await drain();
    h.edit({ b: "two" });
    const second = fakeServer([loaded({ a: "one" }, 5)], [saved(6)]);
    const resync = h.doc.sync(second.rpc);
    await drain();
    expect(second.calls).toEqual([]); // the reload waits for the save in flight
    answer({ revision: 2 });
    await resync;
    await drain();
    // 5 is the reloaded document's revision; 2 would be the answer of the save that was in flight.
    expect(second.sets()).toEqual([{ key: "appearance", value: { a: "one", b: "two" }, baseRevision: 5 }]);
  });

  it("does not send a change made while a conflict retry travels until the re-sync has reloaded", async () => {
    const h = harness();
    let conflict: (reason: unknown) => void = () => {};
    let retried: (value: unknown) => void = () => {};
    const first = fakeServer(
      [loaded({}, 1), loaded({}, 2)],
      [
        () => new Promise((_, reject) => (conflict = reject)),
        () => new Promise((resolve) => (retried = resolve)),
      ],
    );
    await h.doc.sync(first.rpc);
    h.edit({ a: "one" });
    h.timers.fire();
    await drain();
    const second = fakeServer([loaded({ a: "one" }, 7)], [saved(8)]);
    const resync = h.doc.sync(second.rpc);
    await drain();
    conflict(new RpcError("conflict"));
    await drain();
    h.edit({ b: "two" }); // the conflict reload has set the phase back to loaded; the retry is in flight
    h.timers.fire();
    retried({ revision: 3 });
    await drain();
    await resync;
    await drain();
    expect(second.calls.map((call) => call.method)).toEqual(["settings.get", "settings.set"]); // reload first
    expect(second.sets()).toEqual([{ key: "appearance", value: { a: "one", b: "two" }, baseRevision: 7 }]);
  });

  it("does nothing after dispose", async () => {
    const h = harness();
    const server = fakeServer([loaded({}, 1)], []);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.doc.dispose();
    expect(h.timers.pending()).toBe(0);
    h.timers.fire();
    await drain();
    expect(server.sets()).toEqual([]);
  });
});
