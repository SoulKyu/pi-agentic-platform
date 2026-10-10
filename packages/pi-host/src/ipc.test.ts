import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createIpc } from "./ipc.ts";

interface FakeOptions {
  /** No IPC channel at all: the process was not started with fork. */
  noChannel?: boolean;
  /** What process.send does with a record while the channel is open. */
  onSend?: (record: unknown) => boolean | undefined;
}

// Models process.send as Node documents and implements it: on a closed channel it does not throw, it returns false
// and emits ERR_IPC_CHANNEL_CLOSED on the process asynchronously (checked against Node 24.14).
function fakeProcess(options: FakeOptions = {}) {
  const emitter = new EventEmitter();
  const stderr: string[] = [];
  const state = { connected: true };
  const send = (record: unknown): boolean => {
    if (!state.connected) {
      process.nextTick(() =>
        emitter.emit("error", Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" })),
      );
      return false;
    }
    return options.onSend?.(record) ?? true;
  };
  const proc = Object.assign(emitter, {
    send: options.noChannel ? undefined : send,
    stderr: {
      write: (text: string) => {
        stderr.push(text);
        return true;
      },
    },
  });
  Object.defineProperty(proc, "connected", { get: () => state.connected });
  const close = () => {
    state.connected = false;
    emitter.emit("disconnect");
  };
  return { proc: proc as unknown as NodeJS.Process, emitter, stderr, state, close };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createIpc", () => {
  it("refuses to run without an IPC channel", () => {
    const { proc } = fakeProcess({ noChannel: true });
    expect(() => createIpc(proc)).toThrow("start it with child_process.fork");
  });

  it("sends records through the channel", () => {
    const sent: unknown[] = [];
    const { proc } = fakeProcess({ onSend: (record) => void sent.push(record) });
    createIpc(proc).send({ type: "health", rssMb: 1 });
    expect(sent).toEqual([{ type: "health", rssMb: 1 }]);
  });

  it("delivers valid daemon records and drops malformed ones without echoing them", () => {
    const { proc, emitter, stderr } = fakeProcess();
    const listener = vi.fn();
    createIpc(proc).onMessage(listener);
    emitter.emit("message", { type: "get_state", id: "r1" });
    emitter.emit("message", { type: "rm_rf", secret: "do-not-log" });
    emitter.emit("message", { type: "prompt", id: "r2" });
    emitter.emit("message", "text");
    expect(listener.mock.calls).toEqual([[{ type: "get_state", id: "r1" }]]);
    expect(stderr).toEqual([
      "pi-host: dropped a malformed record (fields: type)\n",
      "pi-host: dropped a malformed record (fields: message)\n",
      "pi-host: dropped a malformed record (fields: <record>)\n",
    ]);
  });

  it("hands what it dropped to the malformed listener", () => {
    const { proc, emitter } = fakeProcess();
    const malformed = vi.fn();
    createIpc(proc).onMessage(vi.fn(), malformed);
    emitter.emit("message", { type: "prompt", id: "r2" });
    emitter.emit("message", { type: "get_state", id: "r1" });
    expect(malformed.mock.calls).toEqual([[{ type: "prompt", id: "r2" }]]);
  });

  it("stops delivering after the listener is removed", () => {
    const { proc, emitter } = fakeProcess();
    const listener = vi.fn();
    const off = createIpc(proc).onMessage(listener);
    off();
    emitter.emit("message", { type: "get_state", id: "r1" });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createIpc: the channel closing", () => {
  it("reports a disconnect once", () => {
    const { proc, close } = fakeProcess();
    const listener = vi.fn();
    createIpc(proc).onDisconnect(listener);
    close();
    close();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("treats a send on a closed channel as the channel closing, once, even when the error event follows", async () => {
    const { proc, state, stderr } = fakeProcess();
    const ipc = createIpc(proc);
    const listener = vi.fn();
    ipc.onDisconnect(listener);
    state.connected = false;
    ipc.send({ type: "health", rssMb: 1 });
    ipc.send({ type: "health", rssMb: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stderr).toEqual([]);
  });

  it("treats the ERR_IPC_CHANNEL_CLOSED error event as the channel closing", () => {
    const { proc, emitter } = fakeProcess();
    const listener = vi.fn();
    createIpc(proc).onDisconnect(listener);
    emitter.emit("error", Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not take a backed-up channel for a closed one", () => {
    const { proc } = fakeProcess({ onSend: () => false });
    const ipc = createIpc(proc);
    const listener = vi.fn();
    ipc.onDisconnect(listener);
    ipc.send({ type: "health", rssMb: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("calls a listener added after the channel closed", () => {
    const { proc, close } = fakeProcess();
    const ipc = createIpc(proc);
    close();
    const listener = vi.fn();
    ipc.onDisconnect(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("logs any other process error and keeps the channel", () => {
    const { proc, emitter, stderr } = fakeProcess();
    const listener = vi.fn();
    createIpc(proc).onDisconnect(listener);
    emitter.emit("error", Object.assign(new Error("something\nelse"), { code: "EOTHER" }));
    expect(listener).not.toHaveBeenCalled();
    expect(stderr).toEqual(["pi-host: ipc error: something else\n"]);
  });

  it("logs a record that cannot be serialized and keeps the channel", () => {
    const { proc, stderr } = fakeProcess({ onSend: (record) => void JSON.stringify(record) });
    const ipc = createIpc(proc);
    const listener = vi.fn();
    ipc.onDisconnect(listener);
    ipc.send({ type: "health", rssMb: 10n });
    expect(listener).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^pi-host: ipc send failed: .*BigInt/);
  });
});
