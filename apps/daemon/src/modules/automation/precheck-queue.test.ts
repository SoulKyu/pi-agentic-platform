import { describe, expect, it } from "vitest";
import { createPrecheckQueue } from "./precheck-queue.ts";

const settled = async (work: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void work.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe("the precheck queue (M10R71)", () => {
  it("refuses a second precheck of a trigger that already has one, running or waiting", async () => {
    const queue = createPrecheckQueue();
    const first = await queue.acquire("t1", "scheduler");
    expect(first).toMatchObject({ ok: true });
    expect(await queue.acquire("t1", "scheduler")).toEqual({ ok: false, reason: "busy" });
    expect(await queue.acquire("t1", "manual")).toEqual({ ok: false, reason: "busy" });
    if (first.ok) first.release();
    expect(await queue.acquire("t1", "scheduler")).toMatchObject({ ok: true });
  });

  it("lets two run in the daemon and makes the third wait for a release, first in first out", async () => {
    const queue = createPrecheckQueue();
    const a = await queue.acquire("t1", "manual");
    const b = await queue.acquire("t2", "manual");
    const third = queue.acquire("t3", "manual");
    const fourth = queue.acquire("t4", "manual");
    expect(await settled(third)).toBe(false);
    if (a.ok) a.release();
    expect(await third).toMatchObject({ ok: true });
    expect(await settled(fourth)).toBe(false);
    if (b.ok) b.release();
    expect(await fourth).toMatchObject({ ok: true });
  });

  it("refuses the ninth manual precheck waiting, and a freed slot is not lost to a refusal", async () => {
    const queue = createPrecheckQueue();
    await queue.acquire("r1", "scheduler");
    await queue.acquire("r2", "scheduler");
    const waiting = Array.from({ length: 8 }, (_, index) => queue.acquire(`m${index}`, "manual"));
    expect(await queue.acquire("m8", "manual")).toEqual({ ok: false, reason: "busy" });
    expect(await settled(waiting[0] as Promise<unknown>)).toBe(false);
  });

  it("queues twelve scheduler prechecks of twelve triggers without a refusal and runs them all", async () => {
    const queue = createPrecheckQueue();
    const ran: string[] = [];
    const all = Array.from({ length: 12 }, async (_, index) => {
      const slot = await queue.acquire(`s${index}`, "scheduler");
      if (!slot.ok) throw new Error("refused");
      ran.push(`s${index}`);
      await Promise.resolve();
      slot.release();
    });
    await Promise.all(all);
    expect(ran).toHaveLength(12);
  });

  it("drops a waiting precheck whose caller aborted, and keeps its place for nobody", async () => {
    const queue = createPrecheckQueue();
    const a = await queue.acquire("t1", "manual");
    await queue.acquire("t2", "manual");
    const controller = new AbortController();
    const waiting = queue.acquire("t3", "manual", controller.signal);
    controller.abort();
    expect(await waiting).toEqual({ ok: false, reason: "aborted" });
    if (a.ok) a.release();
    expect(await queue.acquire("t3", "manual")).toMatchObject({ ok: true });
  });

  it("answers aborted at once for a signal that is already aborted", async () => {
    const queue = createPrecheckQueue();
    expect(await queue.acquire("t1", "manual", AbortSignal.abort())).toEqual({
      ok: false,
      reason: "aborted",
    });
  });
});
