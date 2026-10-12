import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createIpc, MAX_RECORD_BYTES } from "./ipc.ts";

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
    expect(stderr[0]).toMatch(/^pi-host: a health record could not be serialised: .*BigInt/);
  });
});

describe("createIpc: record size", () => {
  const bytes = (record: unknown) => Buffer.byteLength(JSON.stringify(record));
  // A record of exactly `size` bytes once serialized, padded with a character that takes `width` bytes.
  const recordOf = (size: number, pad = "x", width = 1) => {
    const overhead = bytes({ type: "message_update", pad: "" });
    return { type: "message_update", pad: pad.repeat((size - overhead) / width) };
  };

  it("limits a record to 4 MiB of JSON", () => {
    expect(MAX_RECORD_BYTES).toBe(4 * 1024 * 1024);
  });

  it("sends a record of exactly the limit and drops one byte more", () => {
    const sent: unknown[] = [];
    const { proc, stderr } = fakeProcess({ onSend: (record) => void sent.push(record) });
    const ipc = createIpc(proc);
    const atLimit = recordOf(MAX_RECORD_BYTES);
    expect(bytes(atLimit)).toBe(MAX_RECORD_BYTES);
    ipc.send(atLimit);
    expect(sent).toEqual([atLimit]);
    ipc.send(recordOf(MAX_RECORD_BYTES + 1));
    expect(sent).toHaveLength(2);
    expect(stderr).toHaveLength(1);
  });

  it("counts bytes, not characters: a multi-byte record under the limit in characters is dropped", () => {
    const sent: unknown[] = [];
    const { proc } = fakeProcess({ onSend: (record) => void sent.push(record) });
    const heavy = recordOf(MAX_RECORD_BYTES + 100, "é", 2);
    expect(JSON.stringify(heavy).length).toBeLessThan(MAX_RECORD_BYTES);
    createIpc(proc).send(heavy);
    expect(sent).toEqual([expect.objectContaining({ type: "extension_error" })]);
  });

  it("drops an oversize record with one bounded stderr line and tells the daemon in an extension_error", () => {
    const sent: unknown[] = [];
    const { proc, stderr } = fakeProcess({ onSend: (record) => void sent.push(record) });
    createIpc(proc).send(recordOf(5 * 1024 * 1024));
    expect(stderr).toEqual([
      `pi-host: dropped a message_update record of ${bytes(recordOf(5 * 1024 * 1024))} bytes: the limit is ${MAX_RECORD_BYTES}\n`,
    ]);
    expect(sent).toEqual([
      {
        type: "extension_error",
        extensionPath: "pi-host:ipc",
        event: "message_update",
        error: `a record of ${bytes(recordOf(5 * 1024 * 1024))} bytes was dropped: the limit is ${MAX_RECORD_BYTES}`,
      },
    ]);
  });

  it("never lets the type of a dropped record forge a log line or grow it", () => {
    const { proc, stderr } = fakeProcess();
    createIpc(proc).send({
      ...recordOf(MAX_RECORD_BYTES + 1),
      type: `evil\npi-host: forged ${"y".repeat(500)}`,
    });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.trimEnd()).not.toContain("\n");
    expect(stderr[0]?.length).toBeLessThan(200);
  });

  it("answers a response it had to drop with a failed response, so the daemon does not wait for it", () => {
    const sent: unknown[] = [];
    const { proc } = fakeProcess({ onSend: (record) => void sent.push(record) });
    createIpc(proc).send({
      type: "response",
      id: "r7",
      command: "get_state",
      success: true,
      data: "x".repeat(MAX_RECORD_BYTES),
    });
    expect(sent).toEqual([
      { type: "response", id: "r7", command: "get_state", success: false, error: "record too large" },
    ]);
  });

  it("keeps the whole id on the response that replaces a dropped one, however long it is", () => {
    const sent: Array<{ id?: string }> = [];
    const { proc } = fakeProcess({ onSend: (record) => void sent.push(record as { id?: string }) });
    const id = `r${"9".repeat(100)}`;
    createIpc(proc).send({
      type: "response",
      id,
      command: "get_state",
      success: true,
      data: "x".repeat(MAX_RECORD_BYTES),
    });
    expect(sent[0]?.id).toBe(id);
  });

  it("reports the first, second, fourth and eighth drop only, but still answers every dropped response", () => {
    const sent: Array<{ type: string }> = [];
    const { proc, stderr } = fakeProcess({ onSend: (record) => void sent.push(record as { type: string }) });
    const ipc = createIpc(proc);
    for (let drop = 0; drop < 9; drop++) ipc.send(recordOf(MAX_RECORD_BYTES + 1));
    expect(stderr).toHaveLength(4);
    expect(sent.filter((record) => record.type === "extension_error")).toHaveLength(4);
    sent.length = 0;
    for (let drop = 0; drop < 3; drop++) {
      ipc.send({
        type: "response",
        id: `r${drop}`,
        command: "x",
        success: true,
        data: "x".repeat(MAX_RECORD_BYTES),
      });
    }
    expect(sent.map((record) => record.type)).toEqual(["response", "response", "response"]);
  });

  it("answers a response it cannot serialise with a failed response of the same id", () => {
    const sent: unknown[] = [];
    const { proc } = fakeProcess({ onSend: (record) => void sent.push(record) });
    const ipc = createIpc(proc);
    expect(
      ipc.send({ type: "response", id: "r7", command: "get_state", success: true, data: { big: 1n } }),
    ).toBe(false);
    expect(sent).toEqual([
      {
        type: "response",
        id: "r7",
        command: "get_state",
        success: false,
        error: "response could not be serialised",
      },
    ]);
  });

  it("says whether a record left", () => {
    const { proc } = fakeProcess();
    const ipc = createIpc(proc);
    expect(ipc.send({ type: "health", rssMb: 1 })).toBe(true);
    expect(ipc.send({ type: "health", blob: "x".repeat(MAX_RECORD_BYTES) })).toBe(false);
  });
});
