import { FILE_CHUNK_BYTES, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createFilesDelivery, deliverAgentFiles, HOME_PUT_TIMEOUT_MS } from "./deliver-files.ts";
import { specOf } from "./runtime-fixtures.ts";

type Frame = { type: string; id: string; path: string; offset?: number; data?: string; last?: boolean };

/** A worker that answers each frame with `answer(frame)` (undefined: never), and a way to make it leave. */
function fakeWorker(answer: (frame: Frame) => { ok: boolean } | undefined = () => ({ ok: true })) {
  const frames: Frame[] = [];
  const listeners = new Set<(record: unknown) => void>();
  let leave: () => void = () => {};
  const exited = new Promise<unknown>((resolve) => (leave = () => resolve({})));
  const handle = {
    exited,
    send: (frame: Frame) => {
      frames.push(frame);
      const reply = answer(frame);
      if (reply)
        queueMicrotask(() => listeners.forEach((l) => l({ type: "home_result", id: frame.id, ...reply })));
      return true;
    },
    onRecord: (listener: (record: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as WorkerHandle;
  const reply = (frame: Frame, answer: { ok: boolean } = { ok: true }): void =>
    listeners.forEach((l) => l({ type: "home_result", id: frame.id, ...answer }));
  return { handle, frames, leave, listeners, reply };
}
const clock = createFakeClock();

describe("deliverAgentFiles", () => {
  it("sends each file in order in chunks of FILE_CHUNK_BYTES, one frame at a time, then the removals", async () => {
    const worker = fakeWorker();
    const big = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 5, 7);
    await deliverAgentFiles(
      worker.handle,
      [
        { path: ".kube/config", bytes: big },
        { path: "empty", bytes: Buffer.alloc(0) },
      ],
      ["old/one", "old/two"],
      { clock },
    );
    expect(worker.frames.map((f) => [f.type, f.path, f.offset, f.last])).toEqual([
      ["home_remove", "old/one", undefined, undefined],
      ["home_remove", "old/two", undefined, undefined],
      ["home_put", ".kube/config", 0, false],
      ["home_put", ".kube/config", FILE_CHUNK_BYTES, false],
      ["home_put", ".kube/config", FILE_CHUNK_BYTES * 2, true],
      ["home_put", "empty", 0, true],
    ]);
    expect(worker.frames[2]?.id).toBe(worker.frames[4]?.id);
    expect(worker.frames[2]?.id).not.toBe(worker.frames[5]?.id);
    const joined = Buffer.concat(worker.frames.slice(2, 5).map((f) => Buffer.from(f.data ?? "", "base64")));
    expect(joined.equals(big)).toBe(true);
    expect(worker.listeners.size).toBe(0);
  });

  it("sends the removals first and keeps going past a refused put, rejecting at the end", async () => {
    const worker = fakeWorker((frame) => ({ ok: frame.path !== "a" }));
    const removed: string[] = [];
    await expect(
      deliverAgentFiles(
        worker.handle,
        [
          { path: "a", bytes: Buffer.from("x") },
          { path: "b", bytes: Buffer.from("y") },
        ],
        ["c"],
        { clock, onRemoved: (path) => removed.push(path) },
      ),
    ).rejects.toEqual(new PapError("worker_failed"));
    expect(worker.frames.map((f) => [f.type, f.path])).toEqual([
      ["home_remove", "c"],
      ["home_put", "a"],
      ["home_put", "b"],
    ]);
    expect(removed).toEqual(["c"]);
  });

  it("does not report a refused removal as removed", async () => {
    const worker = fakeWorker(() => ({ ok: false }));
    const removed: string[] = [];
    await expect(
      deliverAgentFiles(worker.handle, [], ["c"], { clock, onRemoved: (path) => removed.push(path) }),
    ).rejects.toBeInstanceOf(PapError);
    expect(removed).toEqual([]);
  });

  it("rejects when the worker does not answer in time", async () => {
    const worker = fakeWorker(() => undefined);
    const settled = deliverAgentFiles(worker.handle, [{ path: "a", bytes: Buffer.from("x") }], [], { clock });
    const caught = expect(settled).rejects.toEqual(new PapError("worker_failed"));
    await clock.advance(HOME_PUT_TIMEOUT_MS);
    await caught;
  });

  it("rejects when the worker leaves", async () => {
    const worker = fakeWorker(() => undefined);
    const settled = deliverAgentFiles(worker.handle, [{ path: "a", bytes: Buffer.from("x") }], [], { clock });
    const caught = expect(settled).rejects.toEqual(new PapError("worker_failed"));
    worker.leave();
    await caught;
  });
});

describe("createFilesDelivery", () => {
  const store = (removals: string[]) => {
    const delivered = vi.fn();
    const changes: Array<(agentId: string, path: string) => void> = [];
    return {
      delivered,
      changes,
      port: {
        read: vi.fn(() =>
          Promise.resolve([
            { path: "a", bytes: Buffer.from("A") },
            { path: "b", bytes: Buffer.from("B") },
          ]),
        ),
        pendingRemovals: vi.fn(() => removals),
        delivered,
        onChange: (listener: (agentId: string, path: string) => void) => void changes.push(listener),
        purgeTrash: vi.fn(),
        sweepTrash: vi.fn(),
      },
    };
  };

  it("a thread VM start sends every file and confirms the removals", async () => {
    const s = store(["gone"]);
    const worker = fakeWorker();
    await createFilesDelivery({ files: s.port, clock, logger: silentLogger }).start(
      specOf("scout-ab12"),
      worker.handle,
    );
    expect(worker.frames.map((f) => f.path)).toEqual(["gone", "a", "b"]);
    expect(s.delivered).toHaveBeenCalledWith("scout-ab12", ["gone"]);
  });

  it("a task VM start sends the same but confirms nothing", async () => {
    const s = store(["gone"]);
    const worker = fakeWorker();
    const task = specOf("scout-ab12", { kind: "isolated", taskKey: "0".repeat(32) });
    await createFilesDelivery({ files: s.port, clock, logger: silentLogger }).start(task, worker.handle);
    expect(worker.frames).toHaveLength(3);
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it("a refused delivery confirms nothing", async () => {
    const s = store(["gone"]);
    const worker = fakeWorker(() => ({ ok: false }));
    await expect(
      createFilesDelivery({ files: s.port, clock, logger: silentLogger }).start(
        specOf("scout-ab12"),
        worker.handle,
      ),
    ).rejects.toBeInstanceOf(PapError);
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it("a live change sends only that path (and the pending removals) to the thread VM's worker", async () => {
    const s = store(["gone"]);
    const worker = fakeWorker();
    createFilesDelivery({ files: s.port, clock, logger: silentLogger }).live({
      threadWorker: () => worker.handle,
    });
    s.changes[0]?.("scout-ab12", "b");
    await vi.waitFor(() => expect(s.delivered).toHaveBeenCalledWith("scout-ab12", ["gone"]));
    expect(worker.frames.map((f) => f.path)).toEqual(["gone", "b"]);
  });

  it("a live change with no running thread VM does nothing: the next start delivers", async () => {
    const s = store(["gone"]);
    createFilesDelivery({ files: s.port, clock, logger: silentLogger }).live({
      threadWorker: () => undefined,
    });
    s.changes[0]?.("scout-ab12", "b");
    await Promise.resolve();
    await Promise.resolve();
    expect(s.port.read).not.toHaveBeenCalled();
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it("a failed live delivery is logged, not thrown, and confirms nothing", async () => {
    const s = store(["gone"]);
    const worker = fakeWorker(() => ({ ok: false }));
    const warn = vi.fn();
    createFilesDelivery({ files: s.port, clock, logger: { ...silentLogger, warn } }).live({
      threadWorker: () => worker.handle,
    });
    s.changes[0]?.("scout-ab12", "b");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("agent_files_live_delivery_failed", expect.anything()),
    );
    expect(s.delivered).not.toHaveBeenCalled();
  });

  describe("a worker that joins a VM which already had its start delivery", () => {
    const spec = specOf("scout-ab12");
    it("gets the removal made while the VM had no worker, once", async () => {
      const s = store(["gone"]);
      const delivery = createFilesDelivery({ files: s.port, clock, logger: silentLogger });
      delivery.live({ threadWorker: () => undefined });
      s.changes[0]?.("scout-ab12", "gone");
      await Promise.resolve();
      const second = fakeWorker();
      await delivery.again(spec, second.handle);
      expect(second.frames.map((f) => f.path)).toEqual(["gone", "a", "b"]);
      expect(s.delivered).toHaveBeenCalledWith("scout-ab12", ["gone"]);
      const third = fakeWorker();
      await delivery.again(spec, third.handle);
      expect(third.frames).toEqual([]);
    });

    it("gets the files after a live delivery failed", async () => {
      const s = store(["gone"]);
      const delivery = createFilesDelivery({
        files: s.port,
        clock,
        logger: { ...silentLogger, warn: vi.fn() },
      });
      delivery.live({ threadWorker: () => fakeWorker(() => ({ ok: false })).handle });
      s.changes[0]?.("scout-ab12", "b");
      await vi.waitFor(() => expect(s.port.read).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      const next = fakeWorker();
      await delivery.again(spec, next.handle);
      expect(next.frames.map((f) => f.path)).toEqual(["gone", "a", "b"]);
    });

    it("gets nothing when no change was missed, and a task VM's worker never does", async () => {
      const s = store(["gone"]);
      const delivery = createFilesDelivery({ files: s.port, clock, logger: silentLogger });
      const quiet = fakeWorker();
      await delivery.again(spec, quiet.handle);
      delivery.live({ threadWorker: () => undefined });
      s.changes[0]?.("scout-ab12", "b");
      await Promise.resolve();
      const task = fakeWorker();
      await delivery.again(specOf("scout-ab12", { kind: "isolated", taskKey: "0".repeat(32) }), task.handle);
      expect([quiet.frames, task.frames]).toEqual([[], []]);
    });
  });

  it("a refused put does not stop a removal from being sent and confirmed", async () => {
    const s = store(["gone"]);
    const worker = fakeWorker((frame) => ({ ok: frame.type === "home_remove" }));
    await expect(
      createFilesDelivery({ files: s.port, clock, logger: silentLogger }).start(
        specOf("scout-ab12"),
        worker.handle,
      ),
    ).rejects.toBeInstanceOf(PapError);
    expect(s.delivered).toHaveBeenCalledWith("scout-ab12", ["gone"]);
  });

  it("a live removal waits for the start delivery and the start never rewrites what it removed", async () => {
    const present = new Map([
      ["x", "X"],
      ["b", "B"],
    ]);
    const pending: string[] = [];
    const changes: Array<(agentId: string, path: string) => void> = [];
    const port = {
      read: vi.fn(() =>
        Promise.resolve([...present].map(([path, text]) => ({ path, bytes: Buffer.from(text) }))),
      ),
      pendingRemovals: vi.fn(() => [...pending]),
      delivered: vi.fn((_agentId: string, paths: string[]) => {
        for (const path of paths) pending.splice(pending.indexOf(path), 1);
      }),
      onChange: (listener: (agentId: string, path: string) => void) => void changes.push(listener),
      purgeTrash: vi.fn(),
      sweepTrash: vi.fn(),
    };
    const worker = fakeWorker((frame) =>
      frame.path === "x" && frame.type === "home_put" ? undefined : { ok: true },
    );
    const delivery = createFilesDelivery({ files: port, clock, logger: silentLogger });
    delivery.live({ threadWorker: () => worker.handle });
    const started = delivery.start(specOf("scout-ab12"), worker.handle);
    await vi.waitFor(() => expect(worker.frames).toHaveLength(1));
    // The owner revokes b while the start is still writing x.
    present.delete("b");
    pending.push("b");
    changes[0]?.("scout-ab12", "b");
    await vi.waitFor(() => expect(worker.frames).toHaveLength(1));
    worker.reply(worker.frames[0] as Frame);
    await started;
    await vi.waitFor(() => expect(port.delivered).toHaveBeenCalledWith("scout-ab12", ["b"]));
    const forB = worker.frames.filter((f) => f.path === "b").map((f) => f.type);
    expect(forB.at(-1)).toBe("home_remove");
    expect(pending).toEqual([]);
  });
});
