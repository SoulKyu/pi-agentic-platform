import { PapError, type SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { BEFORE_PROMPT_CAP_MS, createLaneHooks, type LaneRunHooks, type LaneRunInfo } from "./lane-hooks.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow } from "./store.ts";

const row = { id: "s1", ownerId: "u1", cwd: "/lane/a" } as SessionRow;
const sessionOf = (status = "idle", busy = false) =>
  ({ status: () => status, busy: () => busy, leafId: () => "leaf-1" }) as unknown as LiveSession;
const status = (value: string) => ({ kind: "status", status: value }) as unknown as SessionStreamEvent;
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return done;
};

const call = async (
  slot: ReturnType<typeof createLaneHooks>,
  ...args: Parameters<ReturnType<typeof createLaneHooks>["beforePrompt"]>
) => slot.beforePrompt(...args);

function bed(hooks?: Partial<LaneRunHooks>) {
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const slot = createLaneHooks({
    clock,
    logger,
    infoOf: (sessionId): LaneRunInfo => ({ ownerId: "u1", sessionId, cwd: "/lane/a", leafId: "leaf-1" }),
  });
  if (hooks)
    slot.set({
      closed: () => null,
      holdsFiles: () => null,
      beforePrompt: async () => {},
      afterRun: () => {},
      ...hooks,
    });
  return { slot, clock, lines };
}

describe("lane hooks: beforePrompt", () => {
  it("goes at once when no hooks are set, without a promise to yield on (the busy rule, M2R88)", () => {
    const { slot } = bed();
    expect(slot.beforePrompt(row, sessionOf(), undefined)).toBeUndefined();
  });

  it("gives the caller nothing to wait for on a steer or a running session, even with hooks", () => {
    const { slot } = bed();
    const hooked = bed({ beforePrompt: async () => {} }).slot;
    expect(hooked.beforePrompt(row, sessionOf("running", true), "steer")).toBeUndefined();
    expect(hooked.beforePrompt(row, sessionOf("running"), undefined)).toBeUndefined();
    expect(slot.beforePrompt(row, sessionOf(), undefined)).toBeUndefined();
  });

  it("awaits the hook for the prompt of an idle session, with the run info", async () => {
    let release!: () => void;
    const seen: LaneRunInfo[] = [];
    const { slot } = bed({
      beforePrompt: (info) => {
        seen.push(info);
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    const pending = call(slot, row, sessionOf(), undefined);
    expect(await settled(pending)).toBe(false);
    release();
    expect(await settled(pending)).toBe(true);
    expect(seen).toEqual([{ ownerId: "u1", sessionId: "s1", cwd: "/lane/a", leafId: "leaf-1" }]);
  });

  it("calls the hook for an idle session whatever streaming preference the composer sends (M2R58)", async () => {
    const hook = vi.fn(async () => {});
    const { slot } = bed({ beforePrompt: hook });
    await call(slot, row, sessionOf("idle"), "followUp");
    await call(slot, row, sessionOf("idle"), "steer");
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("makes a composer-shaped prompt (followUp) wait for a restore holding the files, and marks it waiting", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const hook = vi.fn(async () => {});
    const { slot } = bed({ beforePrompt: hook, holdsFiles: () => held });
    const pending = call(slot, row, sessionOf("idle"), "followUp");
    expect(slot.waiting(row.id)).toBe(true);
    expect(await settled(pending)).toBe(false);
    expect(hook).not.toHaveBeenCalled();
    release();
    await pending;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(slot.waiting(row.id)).toBe(false);
  });

  it("never calls the hook for a running session or a prompt already pending", async () => {
    const hook = vi.fn(async () => {});
    const { slot } = bed({ beforePrompt: hook });
    await call(slot, row, sessionOf("running", true), "steer");
    await call(slot, row, sessionOf("running"), "followUp");
    await call(slot, row, sessionOf("running"), undefined);
    await call(slot, row, sessionOf("starting"), undefined);
    await call(slot, row, sessionOf("idle", true), undefined);
    expect(hook).not.toHaveBeenCalled();
  });

  it("lets the prompt go after 15 s when the hook never settles, sets released once and logs once", async () => {
    let flag: { readonly value: boolean } | undefined;
    const { slot, clock, lines } = bed({
      beforePrompt: (_info, released) => {
        flag = released;
        return new Promise<void>(() => {});
      },
    });
    const pending = call(slot, row, sessionOf(), undefined);
    await clock.advance(BEFORE_PROMPT_CAP_MS - 1);
    expect(await settled(pending)).toBe(false);
    expect(flag?.value).toBe(false);
    await clock.advance(1);
    await expect(pending).resolves.toBeUndefined();
    expect(flag?.value).toBe(true);
    expect(lines.filter((line) => line.msg === "checkpoint_before_late")).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("lets the prompt go when the hook throws, and clears its timer", async () => {
    const { slot, clock, lines } = bed({
      beforePrompt: () => Promise.reject(new Error("git failed")),
    });
    await expect(call(slot, row, sessionOf(), undefined)).resolves.toBeUndefined();
    expect(clock.pending()).toBe(0);
    expect(lines.filter((line) => line.msg === "lane_before_prompt_failed")).toHaveLength(1);
  });

  it("holds the prompt past 15 s while files are held, until the hold settles, before the hook runs", async () => {
    let finish!: () => void;
    const order: string[] = [];
    const { slot, clock } = bed({
      holdsFiles: () => new Promise<void>((resolve) => (finish = resolve)),
      beforePrompt: async () => void order.push("hook"),
    });
    const pending = call(slot, row, sessionOf(), undefined);
    await clock.advance(BEFORE_PROMPT_CAP_MS * 4);
    expect(await settled(pending)).toBe(false);
    expect(order).toEqual([]);
    finish();
    await pending;
    expect(order).toEqual(["hook"]);
  });

  it("throws session_busy for an archiving lane and not_found for an archived one, calling no hook", async () => {
    const hook = vi.fn(async () => {});
    const holds = vi.fn(() => null);
    let closed: "archiving" | "archived" | null = "archiving";
    const { slot } = bed({ closed: () => closed, beforePrompt: hook, holdsFiles: holds });
    await expect(call(slot, row, sessionOf(), undefined)).rejects.toMatchObject({
      code: "session_busy",
    });
    closed = "archived";
    const error = await call(slot, row, sessionOf(), undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PapError);
    expect(error).toMatchObject({ code: "not_found" });
    expect(hook).not.toHaveBeenCalled();
    expect(holds).not.toHaveBeenCalled();
  });

  it("refuses a steer in a closed lane too", async () => {
    const { slot } = bed({ closed: () => "archiving" });
    await expect(call(slot, row, sessionOf("running", true), "steer")).rejects.toMatchObject({
      code: "session_busy",
    });
  });
});

describe("lane hooks: the wait (M9-RT-06, M9-RT-07, M2R88)", () => {
  it("gives the caller nothing to wait for when the hooks have nothing to do, so the prompt does not yield", () => {
    const { slot } = bed({ beforePrompt: () => undefined });
    expect(slot.beforePrompt(row, sessionOf(), undefined)).toBeUndefined();
    expect(slot.waiting("s1")).toBe(false);
  });

  it("reports the session as waiting from the call until the wait ends, on every outcome", async () => {
    let release!: () => void;
    const { slot, clock } = bed({ beforePrompt: () => new Promise<void>((resolve) => (release = resolve)) });
    const pending = call(slot, row, sessionOf(), undefined);
    expect(slot.waiting("s1")).toBe(true);
    expect(slot.waiting("other")).toBe(false);
    release();
    await pending;
    expect(slot.waiting("s1")).toBe(false);
    const capped = bed({ beforePrompt: () => new Promise<void>(() => {}) });
    const second = call(capped.slot, row, sessionOf(), undefined);
    expect(capped.slot.waiting("s1")).toBe(true);
    await capped.clock.advance(BEFORE_PROMPT_CAP_MS);
    await second;
    expect(capped.slot.waiting("s1")).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("makes a second prompt wait for the capture already running, never run a parallel one", async () => {
    let release!: () => void;
    const hook = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { slot } = bed({ beforePrompt: hook });
    const first = call(slot, row, sessionOf(), undefined);
    const second = call(slot, row, sessionOf(), undefined);
    expect(await settled(second)).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("checks that the lane is still open after the hold and again after the capture", async () => {
    let closed: "archiving" | "archived" | null = null;
    let finish!: () => void;
    const hook = vi.fn(async () => {});
    const { slot } = bed({
      closed: () => closed,
      holdsFiles: () => new Promise<void>((resolve) => (finish = resolve)),
      beforePrompt: hook,
    });
    const afterHold = call(slot, row, sessionOf(), undefined);
    closed = "archiving";
    finish();
    await expect(afterHold).rejects.toMatchObject({ code: "session_busy" });
    expect(hook).not.toHaveBeenCalled();
    expect(slot.waiting("s1")).toBe(false);

    closed = null;
    let release!: () => void;
    const slow = bed({
      closed: () => closed,
      beforePrompt: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const afterCapture = call(slow.slot, row, sessionOf(), undefined);
    closed = "archived";
    release();
    await expect(afterCapture).rejects.toMatchObject({ code: "not_found" });
    expect(slow.slot.waiting("s1")).toBe(false);
  });
});

describe("lane hooks: published", () => {
  it("calls afterRun once on running to idle, never on idle to idle", () => {
    const afterRun = vi.fn();
    const { slot } = bed({ afterRun });
    slot.published("s1", status("idle"));
    slot.published("s1", status("idle"));
    expect(afterRun).not.toHaveBeenCalled();
    slot.published("s1", status("running"));
    slot.published("s1", status("idle"));
    slot.published("s1", status("idle"));
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledWith({
      ownerId: "u1",
      sessionId: "s1",
      cwd: "/lane/a",
      leafId: "leaf-1",
    });
  });

  it("drops the entry when the session goes cold, so the next idle is not a run end", () => {
    const afterRun = vi.fn();
    const { slot } = bed({ afterRun });
    slot.published("s1", status("running"));
    slot.published("s1", status("cold"));
    slot.published("s1", status("idle"));
    expect(afterRun).not.toHaveBeenCalled();
    expect(slot.tracked()).toBe(1);
    slot.published("s1", status("cold"));
    expect(slot.tracked()).toBe(0);
  });

  it("ignores events that are not statuses and logs a throwing or rejecting afterRun", async () => {
    const afterRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockImplementationOnce(() => {
        throw new Error("y");
      });
    const { slot, lines } = bed({ afterRun });
    slot.published("s1", { kind: "name" } as unknown as SessionStreamEvent);
    expect(slot.tracked()).toBe(0);
    for (let i = 0; i < 2; i++) {
      slot.published("s1", status("running"));
      slot.published("s1", status("idle"));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lines.filter((line) => line.msg === "lane_after_run_failed")).toHaveLength(2);
  });
});
