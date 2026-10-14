import { describe, expect, it } from "vitest";
import { createRpcClient, RpcError } from "./rpc.ts";
import { fakeConnection } from "./testing.ts";

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      set: (fn: () => void) => {
        pending.set(next, fn);
        return next++;
      },
      clear: (id: number) => {
        pending.delete(id);
      },
    },
    fire: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count: () => pending.size,
  };
}

function commandIds() {
  let next = 0;
  return () => `cmd-${String(++next).padStart(8, "0")}`;
}

describe("rpc client", () => {
  it("resolves with the result and adds a commandId to mutations only", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: () => "cmd-00000001",
      timers: manualTimers().timers,
    });
    const listed = rpc.call("sessions.list", {});
    const created = rpc.call("sessions.create", { cwd: "/w" });
    expect(fake.sent).toEqual([
      { id: 1, method: "sessions.list", params: {} },
      { id: 2, method: "sessions.create", params: { cwd: "/w" }, commandId: "cmd-00000001" },
    ]);
    fake.deliver({ id: 1, ok: true, result: { sessions: [] } });
    fake.deliver({ id: 2, ok: true, result: { sessionId: "s1" } });
    expect(await listed).toEqual({ sessions: [] });
    expect(await created).toEqual({ sessionId: "s1" });
  });

  it("sends a commandId with every mutation, abort included, and a fresh one per call", () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    void rpc.call("sessions.abort", { sessionId: "s1" });
    void rpc.call("sessions.abort", { sessionId: "s1" });
    void rpc.call("sessions.respondDialog", {
      sessionId: "s1",
      dialogId: "d1",
      response: { confirmed: true },
    });
    void rpc.call("unsubscribe", { sub: "s1" });
    expect(fake.sent.map((frame) => frame.commandId)).toEqual([
      "cmd-00000001",
      "cmd-00000002",
      "cmd-00000003",
      undefined,
    ]);
  });

  it("sends the command id it is given on a mutation, a fresh one otherwise, and reads ignore it", () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    const first = rpc.newCommandId();
    void rpc.call("sessions.abort", { sessionId: "s1" }, { commandId: "kept-id-001" });
    void rpc.call("sessions.abort", { sessionId: "s1" }, { commandId: "kept-id-001" });
    void rpc.call("sessions.abort", { sessionId: "s1" });
    void rpc.call("sessions.list", {}, { commandId: "ignored-id-1" });
    expect([first, ...fake.sent.map((frame) => frame.commandId)]).toEqual([
      "cmd-00000001",
      "kept-id-001",
      "kept-id-001",
      "cmd-00000002",
      undefined,
    ]);
  });

  it("rejects with the server error code", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: () => "cmd-00000002",
      timers: manualTimers().timers,
    });
    const call = rpc.call("sessions.create", { cwd: "relative" });
    fake.deliver({ id: 1, ok: false, error: { code: "invalid_cwd" } });
    await expect(call).rejects.toEqual(new RpcError("invalid_cwd"));
  });

  it("keeps the worker counts of a capacity refusal on the error", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: () => "cmd-00000002",
      timers: manualTimers().timers,
    });
    const call = rpc.call("sessions.create", { cwd: "/w" });
    fake.deliver({ id: 1, ok: false, error: { code: "capacity", workers: { used: 6, max: 6 } } });
    await expect(call).rejects.toMatchObject({ code: "capacity", workers: { used: 6, max: 6 } });
  });

  it("surfaces a timeout as an unknown outcome and never sends the mutation again", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    const call = rpc.call("sessions.abort", { sessionId: "s1" });
    fake.deliver({ id: 1, ok: false, error: { code: "timeout" } });
    await expect(call).rejects.toMatchObject({ name: "RpcError", code: "timeout" });
    fake.setState("waiting");
    fake.setState("open");
    expect(fake.sent.filter((frame) => frame.method === "sessions.abort")).toHaveLength(1);
  });

  it("rejects pending calls when the connection drops, and never resends them", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: () => "cmd-00000003",
      timers: manualTimers().timers,
    });
    const call = rpc.call("sessions.prompt", { sessionId: "s1", text: "hi" });
    fake.setState("waiting");
    await expect(call).rejects.toEqual(new RpcError("connection_lost"));
    fake.setState("open");
    expect(fake.sent.filter((f) => f.method === "sessions.prompt")).toHaveLength(1);
  });

  it("ignores a late answer to a call that already failed", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    const first = rpc.call("sessions.list", {});
    fake.setState("waiting");
    await expect(first).rejects.toEqual(new RpcError("connection_lost"));
    fake.setState("open");
    const second = rpc.call("sessions.list", {});
    fake.deliver({ id: 1, ok: true, result: { sessions: ["stale"] } });
    fake.deliver({ id: 2, ok: true, result: { sessions: [] } });
    expect(await second).toEqual({ sessions: [] });
  });

  it("refuses frames above 1 MiB and calls while offline", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: () => "cmd-00000004",
      timers: manualTimers().timers,
    });
    await expect(
      rpc.call("sessions.prompt", { sessionId: "s1", text: "x".repeat(1024 * 1024) }),
    ).rejects.toEqual(new RpcError("payload_too_large"));
    expect(fake.sent).toEqual([]);
    fake.setState("waiting");
    await expect(rpc.call("sessions.list", {})).rejects.toEqual(new RpcError("offline"));
  });

  it("measures the frame in bytes, not characters", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    const text = "é".repeat(600 * 1024);
    await expect(rpc.call("sessions.prompt", { sessionId: "s1", text })).rejects.toEqual(
      new RpcError("payload_too_large"),
    );
  });

  it("rejects with offline when the socket refuses the frame", async () => {
    const fake = fakeConnection("open");
    fake.connection.send = () => false;
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    await expect(rpc.call("sessions.list", {})).rejects.toEqual(new RpcError("offline"));
  });

  it("settles a call whose error code this build does not know, instead of leaving it pending", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    const unknown = rpc.call("sessions.list", {});
    fake.deliver({ id: 1, ok: false, error: { code: "teapot" } });
    await expect(unknown).rejects.toMatchObject({ name: "RpcError", code: "teapot" });
    const bare = rpc.call("sessions.list", {});
    fake.deliver({ id: 2, ok: false });
    await expect(bare).rejects.toMatchObject({ code: "internal" });
    const odd = rpc.call("sessions.list", {});
    fake.deliver({ id: 3, ok: false, error: { code: 7 } });
    await expect(odd).rejects.toMatchObject({ code: "internal" });
  });

  it("ignores frames that are not responses to a pending call", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, {
      newCommandId: commandIds(),
      timers: manualTimers().timers,
    });
    const call = rpc.call("sessions.list", {});
    fake.deliver({ sub: "s1", epoch: "e1", seq: 1, event: {} });
    fake.deliver({ id: 99, ok: true, result: {} });
    fake.deliver({ id: 1, ok: true, result: { sessions: [] } });
    expect(await call).toEqual({ sessions: [] });
  });

  it("pings while open, keeps pinging, and stops once the connection leaves open", () => {
    const fake = fakeConnection("connecting");
    const manual = manualTimers();
    createRpcClient(fake.connection, { newCommandId: () => "cmd-00000005", timers: manual.timers });
    expect(manual.count()).toBe(0);
    fake.setState("open");
    manual.fire();
    expect(fake.sent.at(-1)).toMatchObject({ method: "system.ping" });
    manual.fire();
    expect(fake.sent.filter((frame) => frame.method === "system.ping")).toHaveLength(2);
    fake.setState("waiting");
    expect(manual.count()).toBe(0);
  });
});
