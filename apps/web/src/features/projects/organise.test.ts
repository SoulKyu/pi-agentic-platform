// @vitest-environment happy-dom
import type { MarkState } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { organise, organiseProject, undo, UNDO_WAIT_MS } from "./organise.ts";

const NOW = 1_800_000_000_000;
let ids = 0;
let resync = vi.fn();
const rpc = (call: (method: string, params: unknown) => Promise<unknown>) =>
  ({ call: vi.fn(call), newCommandId: () => `cmd-${++ids}` }) as never;
const deps = (call: ReturnType<typeof rpc>) => ({ rpc: call, store: useShellStore, resync });
const calls = (call: ReturnType<typeof rpc>) => (call as { call: ReturnType<typeof vi.fn> }).call;
const store = () => useShellStore.getState();
const session = (id: string) => store().view.sessions.get(id);
const held = (id: string) => {
  const found = session(id);
  if (!found) throw new Error(`no session ${id}`);
  return found;
};
const captured = (state: MarkState | undefined): MarkState => {
  if (!state) throw new Error("no undo state");
  return state;
};

beforeEach(() => {
  ids = 0;
  resync = vi.fn();
  store().reset();
  store().apply(
    shellSnapshot(
      [
        shellSession({ id: "a" }),
        shellSession({ id: "p1", pinRank: 1 }),
        shellSession({ id: "p2", pinRank: 2 }),
      ],
      { projects: [shellProject({ id: "x", position: 1 }), shellProject({ id: "y", position: 2 })] },
    ),
  );
});
afterEach(() => vi.useRealTimers());

describe("organise (M4R96)", () => {
  it("shows the change at once, sends it with a command id, and confirms it", async () => {
    let answer: (value: unknown) => void = () => {};
    const call = rpc(() => new Promise((resolve) => (answer = resolve)));
    const done = organise({ session: held("a"), change: { kind: "archive" }, now: NOW }, deps(call));
    expect(session("a")?.archivedAt).toBe(NOW);
    expect(store().view.pending.size).toBe(1);
    answer({ ok: true });
    await expect(done).resolves.toMatchObject({ result: "ok", undo: { archived: false, pinned: false } });
    expect(store().view.pending.size).toBe(0);
    expect(calls(call)).toHaveBeenCalledWith(
      "sessions.mark",
      { sessionId: "a", change: { kind: "archive" } },
      { commandId: "cmd-1" },
    );
  });

  it("moves the other pins' ranks too", async () => {
    await organise(
      { session: held("p2"), change: { kind: "pin", before: "p1" }, now: NOW },
      deps(rpc(async () => ({ ok: true }))),
    );
    expect([session("p2")?.pinRank, session("p1")?.pinRank]).toEqual([1, 2]);
  });

  it("rolls back a refusal and says why", async () => {
    const result = await organise(
      { session: held("a"), change: { kind: "snooze", until: NOW + 3_600_000 }, now: NOW },
      deps(
        rpc(async () => {
          throw new RpcError("bad_request");
        }),
      ),
    );
    expect(result).toEqual({ result: "refused", code: "bad_request" });
    expect(session("a")?.snoozedUntil).toBeNull();
  });

  it("a refusal rolls back to the server state, not to a stale snapshot", async () => {
    let fail: (error: Error) => void = () => {};
    const call = rpc(() => new Promise((_, reject) => (fail = reject)));
    const done = organise({ session: held("a"), change: { kind: "settle" }, now: NOW }, deps(call));
    // The server echoes a different state of an unrelated session while the call is in flight.
    store().apply({ kind: "session", session: shellSession({ id: "p1", pinRank: 1, name: "fresh" }) });
    fail(new RpcError("internal"));
    await done;
    expect(session("a")?.settledAt).toBeNull();
    expect(session("p1")?.name).toBe("fresh");
  });

  it("builds the change from the store's session, not a stale caller copy", async () => {
    const stale = held("a");
    store().apply({ kind: "session", session: shellSession({ id: "a", name: "newer", status: "running" }) });
    await organise(
      { session: stale, change: { kind: "settle" }, now: NOW },
      deps(rpc(async () => ({ ok: true }))),
    );
    expect(session("a")).toMatchObject({ name: "newer", status: "running", settledAt: NOW });
  });

  it("a non-RpcError throw is refused as internal and rolled back", async () => {
    const result = await organise(
      { session: held("a"), change: { kind: "settle" }, now: NOW },
      deps(
        rpc(async () => {
          throw new TypeError("boom");
        }),
      ),
    );
    expect(result).toEqual({ result: "refused", code: "internal" });
    expect(session("a")?.settledAt).toBeNull();
    expect(store().view.pending.size).toBe(0);
  });

  it("a server echo supersedes the optimistic state; the confirm leaves it alone", async () => {
    let answer: (value: unknown) => void = () => {};
    const call = rpc(() => new Promise((resolve) => (answer = resolve)));
    const done = organise({ session: held("a"), change: { kind: "settle" }, now: NOW }, deps(call));
    store().apply({
      kind: "session",
      session: shellSession({ id: "a", settledAt: NOW + 5, status: "running" }),
    });
    const echo = session("a");
    answer({ ok: true });
    await done;
    expect(echo).toMatchObject({ settledAt: NOW + 5, status: "running" });
    expect(session("a")).toBe(echo);
  });

  it("refuses locally what the rules refuse, without a request", async () => {
    const call = rpc(async () => ({ ok: true }));
    const result = await organise(
      { session: held("a"), change: { kind: "snooze", until: NOW + 1 }, now: NOW },
      deps(call),
    );
    expect(result).toEqual({ result: "refused", code: "bad_request" });
    expect(calls(call)).not.toHaveBeenCalled();
  });

  it("an unknown outcome keeps the change shown, frees the sidebar at once and asks a fresh snapshot (RT-03)", async () => {
    for (const code of ["connection_lost", "timeout"] as const) {
      store().apply(shellSnapshot([shellSession({ id: "a" })]));
      resync.mockClear();
      const sent = rpc(async () => {
        throw new RpcError(code);
      });
      const result = await organise({ session: held("a"), change: { kind: "settle" }, now: NOW }, deps(sent));
      expect(result).toEqual({ result: "unknown", code });
      expect(calls(sent)).toHaveBeenCalledTimes(1);
      expect(session("a")?.settledAt).toBe(NOW);
      expect(store().view.pending.size).toBe(0);
      expect(resync).toHaveBeenCalledTimes(1);
      const next = await organise(
        { session: held("a"), change: { kind: "unsettle" }, now: NOW },
        deps(rpc(async () => ({ ok: true }))),
      );
      expect(next.result).toBe("ok");
    }
  });

  it("rolls back when nothing was sent (offline)", async () => {
    await organise(
      { session: held("a"), change: { kind: "settle" }, now: NOW },
      deps(
        rpc(async () => {
          throw new RpcError("offline");
        }),
      ),
    );
    expect(session("a")?.settledAt).toBeNull();
    expect(resync).not.toHaveBeenCalled();
  });

  it("waits for one change at a time (M4R83)", async () => {
    let answer: (value: unknown) => void = () => {};
    const call = rpc(() => new Promise((resolve) => (answer = resolve)));
    const first = organise({ session: held("a"), change: { kind: "settle" }, now: NOW }, deps(call));
    await expect(
      organise({ session: held("p1"), change: { kind: "unpin" }, now: NOW }, deps(call)),
    ).resolves.toEqual({ result: "busy" });
    expect(calls(call)).toHaveBeenCalledTimes(1);
    answer({ ok: true });
    await first;
  });

  it("Undo restores the place among the pins", async () => {
    const call = rpc(async () => ({ ok: true }));
    const { undo: state } = await organise(
      { session: held("p1"), change: { kind: "archive" }, now: NOW },
      deps(call),
    );
    expect(state).toEqual({
      pinned: true,
      pinBefore: "p2",
      archived: false,
      settled: false,
      snoozedUntil: null,
    });
    await undo({ sessionId: "p1", state: captured(state), now: () => NOW + 1 }, deps(call));
    expect([session("p1")?.pinRank, session("p2")?.pinRank, session("p1")?.archivedAt]).toEqual([1, 2, null]);
  });

  it("an Undo pressed while another change is saving waits for it, then goes (RT-34)", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => {};
    const slow = rpc(() => new Promise((resolve) => (answer = resolve)));
    void organise({ session: held("a"), change: { kind: "settle" }, now: NOW }, deps(slow));
    const state = { pinned: true, pinBefore: "p2", archived: false, settled: false, snoozedUntil: null };
    const call = rpc(async () => ({ ok: true }));
    const pressed = undo({ sessionId: "p1", state, now: () => NOW }, deps(call));
    answer({ ok: true });
    await expect(pressed).resolves.toMatchObject({ result: "ok" });
    expect(calls(call)).toHaveBeenCalledTimes(1);
  });

  it("an Undo still blocked after UNDO_WAIT_MS answers busy, so the menu can say so (RT-34)", async () => {
    vi.useFakeTimers();
    void organise(
      { session: held("a"), change: { kind: "settle" }, now: NOW },
      deps(rpc(() => new Promise(() => {}))),
    );
    const pressed = undo(
      {
        sessionId: "p1",
        state: { pinned: false, pinBefore: null, archived: false, settled: false, snoozedUntil: null },
        now: () => NOW,
      },
      deps(rpc(async () => ({ ok: true }))),
    );
    await vi.advanceTimersByTimeAsync(UNDO_WAIT_MS);
    await expect(pressed).resolves.toEqual({ result: "busy" });
  });

  it("an Undo of a session evicted from the store is sent without a display, as the one pending change while it saves", async () => {
    const state = { pinned: false, pinBefore: null, archived: false, settled: false, snoozedUntil: null };
    const call = rpc(async () => ({ ok: true }));
    await expect(undo({ sessionId: "gone", state, now: () => NOW }, deps(call))).resolves.toEqual({
      result: "ok",
    });
    expect(calls(call)).toHaveBeenCalledWith(
      "sessions.mark",
      { sessionId: "gone", change: { kind: "restore", state } },
      { commandId: "cmd-1" },
    );
    expect(session("gone")).toBeUndefined();
    expect(store().view.pending.size).toBe(0);
    // One change at a time: the unseen restore is pending while it waits for its answer.
    let answer: (value: unknown) => void = () => {};
    const slow = rpc(() => new Promise((resolve) => (answer = resolve)));
    const sent = undo({ sessionId: "gone", state, now: () => NOW }, deps(slow));
    expect(store().view.pending.size).toBe(1);
    answer({ ok: true });
    await sent;
    expect(store().view.pending.size).toBe(0);
  });

  it("an Undo of an evicted session that the daemon refuses says why", async () => {
    const state = { pinned: true, pinBefore: null, archived: false, settled: false, snoozedUntil: null };
    const refused = rpc(async () => {
      throw new RpcError("limit_reached");
    });
    await expect(undo({ sessionId: "gone", state, now: () => NOW }, deps(refused))).resolves.toEqual({
      result: "refused",
      code: "limit_reached",
    });
    expect(store().view.pending.size).toBe(0);
  });
});

describe("organiseProject", () => {
  const order = () => [...store().view.projects.values()];
  const nth = (index: number) => {
    const found = order()[index];
    if (!found) throw new Error(`no project ${index}`);
    return found;
  };

  it("shows a rename at once and sends it with a command id", async () => {
    const call = rpc(async () => ({ ok: true }));
    const done = organiseProject(
      { project: nth(0), change: { kind: "rename", name: "  New  " }, order: order() },
      deps(call),
    );
    expect(store().view.projects.get("x")?.name).toBe("New");
    await expect(done).resolves.toEqual({ result: "ok" });
    expect(calls(call)).toHaveBeenCalledWith(
      "projects.update",
      { projectId: "x", change: { kind: "rename", name: "  New  " } },
      { commandId: "cmd-1" },
    );
  });

  it("moves a project between its neighbours and rolls a refusal back", async () => {
    const call = rpc(async () => {
      throw new RpcError("not_found");
    });
    const done = organiseProject(
      { project: nth(1), change: { kind: "move", before: "x" }, order: order() },
      deps(call),
    );
    expect(store().view.projects.get("y")?.position).toBe(0);
    await expect(done).resolves.toEqual({ result: "refused", code: "not_found" });
    expect(store().view.projects.get("y")?.position).toBe(2);
  });

  it("refuses a name that is blank once trimmed, before showing or sending anything", async () => {
    const call = rpc(async () => ({ ok: true }));
    for (const name of ["", "   ", "\t\n"]) {
      await expect(
        organiseProject({ project: nth(0), change: { kind: "rename", name }, order: order() }, deps(call)),
      ).resolves.toEqual({ result: "refused", code: "bad_request" });
    }
    expect(calls(call)).not.toHaveBeenCalled();
    expect(store().view.projects.get("x")?.name).toBe("x");
    expect(store().view.pending.size).toBe(0);
  });

  it("answers busy while a change is pending, and resyncs on an unknown outcome", async () => {
    const hang = rpc(() => new Promise(() => {}));
    void organise({ session: held("a"), change: { kind: "settle" }, now: NOW }, deps(hang));
    await expect(
      organiseProject({ project: nth(0), change: { kind: "rename", name: "n" }, order: order() }, deps(hang)),
    ).resolves.toEqual({ result: "busy" });
    store().reset();
    store().apply(shellSnapshot([], { projects: [shellProject({ id: "x" })] }));
    const lost = rpc(async () => {
      throw new RpcError("timeout");
    });
    await expect(
      organiseProject({ project: nth(0), change: { kind: "rename", name: "n" }, order: order() }, deps(lost)),
    ).resolves.toEqual({ result: "unknown", code: "timeout" });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(store().view.pending.size).toBe(0);
  });
});
