import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { bed, settle, specOf, workerInput } from "./runtime-fixtures.ts";

describe("the owner's files at a VM start", () => {
  it("delivers once per VM, with the first worker, and once more for a task VM", async () => {
    const deliverFiles = vi.fn(() => Promise.resolve());
    const b = bed({ deliverFiles });
    await b.runtime.stopAll();
    const first = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(deliverFiles).toHaveBeenCalledTimes(1);
    expect(deliverFiles).toHaveBeenCalledWith(expect.objectContaining({ kind: "thread" }), first.handle);
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    expect(deliverFiles).toHaveBeenCalledTimes(2);
    expect(deliverFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "isolated" }),
      expect.anything(),
    );
  });

  it("offers every later worker of the VM to deliverAgain, task VMs excepted", async () => {
    const deliverAgain = vi.fn(() => Promise.resolve());
    const b = bed({ deliverFiles: () => Promise.resolve(), deliverAgain });
    await b.runtime.stopAll();
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(deliverAgain).not.toHaveBeenCalled();
    const second = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(deliverAgain).toHaveBeenCalledTimes(1);
    expect(deliverAgain).toHaveBeenCalledWith(expect.objectContaining({ kind: "thread" }), second.handle);
  });

  it("does not wait for the delivery: the worker answers only after its init, which comes after spawn", async () => {
    const b = bed({ deliverFiles: () => new Promise<void>(() => {}) });
    await b.runtime.stopAll();
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).resolves.toMatchObject({
      slot: "slot-0",
    });
  });

  it("a failed delivery is logged and the next worker of the VM retries it", async () => {
    const deliverFiles = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new PapError("worker_failed"))
      .mockResolvedValue(undefined);
    const b = bed({ deliverFiles });
    await b.runtime.stopAll();
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await settle();
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(deliverFiles).toHaveBeenCalledTimes(2);
  });
});

describe("threadWorker", () => {
  it("is a worker of the running thread VM, else undefined", async () => {
    const b = bed();
    await b.runtime.stopAll();
    expect(b.runtime.threadWorker("a1")).toBeUndefined();
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    expect(b.runtime.threadWorker("a1")).toBeUndefined();
    const thread = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(b.runtime.threadWorker("a1")).toBe(thread.handle);
    await b.runtime.stop("a1");
    expect(b.runtime.threadWorker("a1")).toBeUndefined();
  });
});
