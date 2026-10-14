import {
  HELPER_MAX_EVENTS,
  HELPER_MAX_PROMPTS,
  HELPER_MAX_RECORD_BYTES,
  type PapError,
} from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeChild, type ForkState, ofType, useHelperBed } from "./testing/pool-bed.ts";

const state = vi.hoisted((): ForkState => ({ children: [], forkArgs: [] }));
vi.mock("node:child_process", () => ({
  fork: vi.fn((...args: unknown[]) => {
    state.forkArgs.push(args);
    const next = state.children.shift();
    if (next instanceof Error) throw next;
    return next;
  }),
}));

const bed = useHelperBed(state);
const { start } = bed;

describe("events and prompts", () => {
  it("hands events and prompts to the caller", () => {
    const events: unknown[] = [];
    const prompts: Array<[string, unknown]> = [];
    const { child } = start({ onEvent: (e) => events.push(e), onPrompt: (id, p) => prompts.push([id, p]) });
    child.deliver({ type: "helper_event", event: { n: 1 } });
    child.deliver({ type: "helper_prompt", promptId: "p1", prompt: { q: "?" } });
    expect(events).toEqual([{ n: 1 }]);
    expect(prompts).toEqual([["p1", { q: "?" }]]);
  });

  it("accepts exactly 256 events and kills the helper on the 257th", async () => {
    const { child, handle } = start();
    const rejected = handle.done.catch((error: PapError) => error);
    for (let i = 0; i < HELPER_MAX_EVENTS; i++) child.deliver({ type: "helper_event", event: i });
    expect(ofType(child, "helper_cancel")).toHaveLength(0);
    child.deliver({ type: "helper_event", event: "one too many" });
    expect(await rejected).toMatchObject({ code: "helper_failed" });
    expect(ofType(child, "helper_cancel")).toHaveLength(1);
    await bed.clock.advance(2000);
    expect(bed.signals()).toContain(`-${child.pid}:SIGTERM`);
  });

  it("accepts 16 prompts and kills the helper on the 17th", async () => {
    const { child, handle } = start();
    const rejected = handle.done.catch((error: PapError) => error);
    for (let i = 0; i < HELPER_MAX_PROMPTS; i++)
      child.deliver({ type: "helper_prompt", promptId: `p${i}`, prompt: i });
    expect(ofType(child, "helper_cancel")).toHaveLength(0);
    child.deliver({ type: "helper_prompt", promptId: "p16", prompt: 16 });
    expect(await rejected).toMatchObject({ code: "helper_failed" });
    expect(ofType(child, "helper_cancel")).toHaveLength(1);
  });

  it("answers a prompt that was asked, once, and returns false for an unknown or answered one", () => {
    const { child, handle } = start();
    expect(handle.answer("p1", "yes")).toBe(false);
    child.deliver({ type: "helper_prompt", promptId: "p1", prompt: {} });
    expect(handle.answer("p1", "yes")).toBe(true);
    expect(ofType(child, "helper_answer")).toEqual([{ type: "helper_answer", promptId: "p1", value: "yes" }]);
    expect(handle.answer("p1", "again")).toBe(false);
    expect(handle.answer("nope", null)).toBe(false);
  });

  it("refuses to send an answer over the 64 KiB bound", () => {
    const { child, handle } = start();
    child.deliver({ type: "helper_prompt", promptId: "p1", prompt: {} });
    expect(handle.answer("p1", "x".repeat(65_537))).toBe(false);
    expect(ofType(child, "helper_answer")).toHaveLength(0);
  });

  it("returns false for an answer once the helper is gone", async () => {
    const { child, handle } = start();
    child.deliver({ type: "helper_prompt", promptId: "p1", prompt: {} });
    child.end();
    await bed.clock.advance(0);
    expect(handle.answer("p1", "late")).toBe(false);
  });
});

describe("a helper that misbehaves", () => {
  it.each([
    [null],
    ["text"],
    [{ nonsense: true }],
    [{ type: "response", id: "r1" }],
    [{ type: "helper_done" }],
  ])("fails helper_failed on a record that is not a helper record: %j", async (raw) => {
    const { child, handle } = start();
    const rejected = handle.done.catch((error: PapError) => error);
    child.deliver(raw);
    expect(await rejected).toMatchObject({ code: "helper_failed" });
    expect(ofType(child, "helper_cancel")).toHaveLength(1);
  });

  it("fails helper_failed on a record over 1 MiB, and takes one of exactly 1 MiB", async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ type: "helper_done", ok: true, result: "" }));
    const fits = start();
    fits.child.deliver({
      type: "helper_done",
      ok: true,
      result: "x".repeat(HELPER_MAX_RECORD_BYTES - overhead),
    });
    expect(await fits.handle.done).toHaveLength(HELPER_MAX_RECORD_BYTES - overhead);
    const over = start();
    const rejected = over.handle.done.catch((error: PapError) => error);
    over.child.deliver({
      type: "helper_done",
      ok: true,
      result: "x".repeat(HELPER_MAX_RECORD_BYTES - overhead + 1),
    });
    expect(await rejected).toMatchObject({ code: "helper_failed" });
    expect(
      bed.logs.some((entry) => (entry.fields as { why?: string } | undefined)?.why === "oversized"),
    ).toBe(true);
  });

  it("fails helper_failed and frees the slot when fork throws", async () => {
    state.children.push(new Error("EAGAIN"));
    const failing = bed.pool.run("ping", {}, { deadlineMs: 1000 });
    await expect(failing.done).rejects.toMatchObject({ code: "helper_failed" });
    expect(bed.pool.active()).toBe(0);
    expect(bed.logs.some((entry) => entry.msg === "helper_failed")).toBe(true);
  });

  it("fails helper_failed and frees the slot when the process never started (no pid)", async () => {
    const child = new FakeChild();
    child.pid = undefined as unknown as number;
    state.children.push(child);
    const failing = bed.pool.run("ping", {}, { deadlineMs: 1000 });
    child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
    await expect(failing.done).rejects.toMatchObject({ code: "helper_failed" });
    expect(bed.pool.active()).toBe(0);
  });
});
