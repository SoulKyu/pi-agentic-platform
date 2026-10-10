import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createIpc } from "./ipc.ts";

function fakeProcess(send: ((record: unknown) => void) | null = () => {}) {
  const emitter = new EventEmitter();
  const stderr: string[] = [];
  const proc = Object.assign(emitter, {
    send: send ?? undefined,
    stderr: {
      write: (text: string) => {
        stderr.push(text);
        return true;
      },
    },
  });
  return { proc: proc as unknown as NodeJS.Process, emitter, stderr };
}

describe("createIpc", () => {
  it("refuses to run without an IPC channel", () => {
    const { proc } = fakeProcess(null);
    expect(() => createIpc(proc)).toThrow("start it with child_process.fork");
  });

  it("sends records through the channel", () => {
    const sent: unknown[] = [];
    const { proc } = fakeProcess((record) => sent.push(record));
    createIpc(proc).send({ type: "health", rssMb: 1 });
    expect(sent).toEqual([{ type: "health", rssMb: 1 }]);
  });

  it("reports a failed send on stderr instead of throwing", () => {
    const { proc, stderr } = fakeProcess(() => {
      throw new Error("channel closed");
    });
    expect(() => createIpc(proc).send({ type: "health", rssMb: 1 })).not.toThrow();
    expect(stderr).toEqual(["pi-host: ipc send failed: channel closed\n"]);
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

  it("reports a disconnect once", () => {
    const { proc, emitter } = fakeProcess();
    const listener = vi.fn();
    createIpc(proc).onDisconnect(listener);
    emitter.emit("disconnect");
    emitter.emit("disconnect");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
