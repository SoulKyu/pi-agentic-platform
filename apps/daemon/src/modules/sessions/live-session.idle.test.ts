import { describe, expect, it } from "vitest";
import { BACKGROUND_RELEASE_MS } from "./idle-release.ts";
import { startLiveSession } from "./live-session.ts";
import { codeOf } from "./testing/helpers.ts";
import { confirm, createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);
type Bed = ReturnType<typeof setup>;

const HALF_HOUR = 30 * 60_000;
const MINUTE = 60_000;
const shutdowns = (worker: Bed["worker"]) =>
  worker.sent.filter((record) => record.type === "shutdown").length;
const statuses = (published: Bed["published"]) =>
  published.flatMap((event) => (event.kind === "status" ? [event] : []));
const health = (descendants: number) => ({ type: "health" as const, rssMb: 80, descendants });
const request = (method: string, fields: Record<string, unknown> = {}) => ({
  type: "extension_ui_request" as const,
  id: "x",
  method,
  ...fields,
});
const closed = (id: string) => ({ type: "extension_ui_closed" as const, id });
const approval = {
  type: "approval_request" as const,
  id: "a1",
  category: "exec" as const,
  title: "Run?",
  message: "bash: ls",
  answers: ["deny", "once"] as Array<"deny" | "once">,
  tool: "bash",
  key: "c".repeat(64),
};

describe("idle release (spec C 2.1)", () => {
  it("releases after 30 idle minutes: releasing, then cold with no error cause", async () => {
    const { published, clock, worker, live } = setup({ idleMs: HALF_HOUR });
    await clock.advance(HALF_HOUR - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(worker.sent.at(-1)).toMatchObject({ type: "shutdown" });
    expect(statuses(published)).toEqual([
      { kind: "status", status: "idle" },
      { kind: "status", status: "releasing" },
      { kind: "status", status: "cold" },
    ]);
    expect(live.status()).toBe("cold");
  });

  it("never releases with a dialog open, and counts the 30 minutes from the answer", async () => {
    const { clock, worker, live } = setup({ idleMs: 1000 });
    worker.emit(confirm);
    await clock.advance(5000);
    expect(worker.stopped()).toBe(false);
    live.answer("d1", { confirmed: true });
    await clock.advance(999);
    expect(worker.stopped()).toBe(false);
    await clock.advance(1);
    expect(worker.stopped()).toBe(true);
  });

  it.each([
    ["a run", piEvent({ type: "agent_start" })],
    ["a compaction", piEvent({ type: "compaction_start", reason: "manual" })],
    ["an automatic retry", piEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 })],
    [
      "a non-empty queue",
      piEvent({ type: "queue_update", steering: ["x"], followUp: [], count: 1, bytes: 1 }),
    ],
  ] as const)("never releases during %s", async (_name, record) => {
    const { clock, worker } = setup({ idleMs: 1000 });
    worker.emit(record);
    await clock.advance(10 * 1000);
    expect(worker.stopped()).toBe(false);
  });

  it("never releases while a prompt waits in the lane hooks (M3)", async () => {
    const waiting = { value: true };
    const { clock, worker } = setup({ idleMs: 1000, held: () => waiting.value });
    await clock.advance(5000);
    expect(worker.stopped()).toBe(false);
    waiting.value = false;
    await clock.advance(1000);
    expect(worker.stopped()).toBe(true);
  });

  it("never releases with a panel open or a command in flight", async () => {
    const panel = setup({ idleMs: 1000 });
    panel.worker.emit({ type: "custom_render", id: "p1", lines: ["x"] });
    await panel.clock.advance(5000);
    expect(panel.worker.stopped()).toBe(false);
    panel.worker.emit({ type: "custom_close", id: "p1" });
    await panel.clock.advance(1000);
    expect(panel.worker.stopped()).toBe(true);

    const { live, worker, clock } = setup({ idleMs: 1000, hold: ["set_session_name"] });
    const pending = live.command({ type: "set_session_name", name: "n" });
    await clock.advance(5000);
    expect(worker.stopped()).toBe(false);
    worker.respond(worker.requests.find((r) => r.type === "set_session_name")?.id ?? "", {});
    await pending;
    await clock.advance(1000);
    expect(worker.stopped()).toBe(true);
  });

  it("counts the quiet from the end of a command, not only from its start", async () => {
    const { live, worker, clock } = setup({ idleMs: 1000, hold: ["set_session_name"] });
    const pending = live.command({ type: "set_session_name", name: "n" });
    await clock.advance(5500);
    worker.respond(worker.requests.find((r) => r.type === "set_session_name")?.id ?? "", {});
    await pending;
    await clock.advance(999);
    expect(worker.stopped()).toBe(false);
    await clock.advance(1);
    expect(worker.stopped()).toBe(true);
  });

  it("never releases while a prompt is on its way, and counts from its answer", async () => {
    const { live, worker, clock } = setup({ idleMs: 1000, holdPrompt: true });
    const prompted = live.prompt("go");
    await clock.advance(5000);
    expect(worker.stopped()).toBe(false);
    worker.respond(worker.requests.find((r) => r.type === "prompt")?.id ?? "", {
      data: { disposition: "queued" },
    });
    await prompted;
    await clock.advance(999);
    expect(worker.stopped()).toBe(false);
    await clock.advance(1);
    expect(worker.stopped()).toBe(true);
  });

  it("releases after 30 idle minutes although the worker reports its health every 30 s (M2-RT-04)", async () => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    for (let at = 0; at < HALF_HOUR; at += 30_000) {
      worker.emit(health(0));
      await clock.advance(30_000);
    }
    expect(worker.sent.at(-1)).toMatchObject({ type: "shutdown" });
  });

  it("is not kept by decorations, extension errors or the keyed throttle's publishes (M2R108, M2R109)", async () => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    for (let at = 0; at < HALF_HOUR; at += 10_000) {
      worker.emit(request("setStatus", { statusKey: "clock", statusText: `t${at}` }));
      worker.emit(request("setWidget", { widgetKey: "w", widgetLines: [`${at}`] }));
      worker.emit(request("setTitle", { title: `t${at}` }));
      worker.emit(request("notify", { message: "tick" }));
      worker.emit({ type: "extension_error", extensionPath: "/x.js", event: "tool_call", error: "boom" });
      worker.emit({ type: "audit", entry: { at, decision: "approved" } } as never);
      await clock.advance(10_000);
    }
    expect(shutdowns(worker)).toBe(1);
  });

  it("is not kept by requests the daemon cancelled: unknown methods are not a person's work", async () => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    for (let at = 0; at < HALF_HOUR; at += 10_000) {
      worker.emit(request("not_a_method", { id: `u${at}` }));
      await clock.advance(10_000);
    }
    expect(worker.sent.filter((record) => record.type === "extension_ui_response").length).toBeGreaterThan(0);
    expect(shutdowns(worker)).toBe(1);
  });

  it.each([
    ["a Pi event", [piEvent({ type: "message_update" })]],
    ["a dialog request", [request("confirm", { id: "d9", title: "t", message: "m" }), closed("d9")]],
    ["an approval request", [approval, closed("a1")]],
  ] as const)("is re-armed by %s", async (_name, records) => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    await clock.advance(20 * MINUTE);
    for (const record of records) worker.emit(record as never);
    await clock.advance(HALF_HOUR - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(shutdowns(worker)).toBe(1);
  });

  it("is re-armed by a panel's render (M2R108)", async () => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    await clock.advance(20 * MINUTE);
    worker.emit({ type: "custom_render", id: "p1", lines: ["x"] });
    worker.emit({ type: "custom_close", id: "p1" });
    await clock.advance(HALF_HOUR - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(shutdowns(worker)).toBe(1);
  });

  it.each([
    ["abort", (live: Bed["live"]) => live.abort()],
    ["clearQueue", (live: Bed["live"]) => live.clearQueue()],
    ["a session command", (live: Bed["live"]) => live.command({ type: "set_session_name", name: "n" })],
    ["a prompt", (live: Bed["live"]) => live.prompt("hi")],
  ])("is re-armed by %s", async (_name, act) => {
    const { clock, worker, live } = setup({ idleMs: HALF_HOUR });
    await clock.advance(20 * MINUTE);
    await act(live);
    await clock.advance(HALF_HOUR - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(shutdowns(worker)).toBe(1);
  });

  it("is re-armed by a panel's input", async () => {
    const { clock, worker, live } = setup({ idleMs: HALF_HOUR });
    worker.emit({ type: "custom_render", id: "p1", lines: ["x"] });
    await clock.advance(20 * MINUTE);
    live.panelInput("p1", "q");
    worker.emit({ type: "custom_close", id: "p1" });
    await clock.advance(HALF_HOUR - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(shutdowns(worker)).toBe(1);
  });

  it("is re-armed by the answer to a dialog", async () => {
    const { clock, worker, live } = setup({ idleMs: HALF_HOUR });
    worker.emit(confirm);
    await clock.advance(20 * MINUTE);
    live.answer("d1", { confirmed: true });
    await clock.advance(HALF_HOUR - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(shutdowns(worker)).toBe(1);
  });

  it("keeps a worker whose agent left a process running (M2-RT-14), and releases it 8 h after its last activity", async () => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    worker.emit(health(1));
    await clock.advance(BACKGROUND_RELEASE_MS - 1);
    expect(shutdowns(worker)).toBe(0);
    await clock.advance(1);
    expect(shutdowns(worker)).toBe(1);
  });

  it("releases at once at the next expiry when the processes are gone", async () => {
    const { clock, worker } = setup({ idleMs: HALF_HOUR });
    worker.emit(health(2));
    await clock.advance(2 * HALF_HOUR);
    expect(shutdowns(worker)).toBe(0);
    worker.emit(health(0));
    await clock.advance(HALF_HOUR);
    expect(shutdowns(worker)).toBe(1);
  });

  it("is off when idleMs is 0", async () => {
    const { clock, worker } = setup({ idleMs: 0 });
    await clock.advance(10 * HALF_HOUR);
    expect(worker.stopped()).toBe(false);
  });
});

describe("a released worker", () => {
  it("leaves no timer of the idle release behind after stop() or an exit", async () => {
    const baseline = setup({ idleMs: 0 });
    await baseline.live.stop();
    await baseline.clock.advance(0);
    const stopped = setup({ idleMs: HALF_HOUR });
    await stopped.live.stop();
    await stopped.clock.advance(0);
    expect(stopped.clock.pending()).toBe(baseline.clock.pending());
    await stopped.clock.advance(2 * HALF_HOUR);
    expect(shutdowns(stopped.worker)).toBe(1);

    const crashed = setup({ idleMs: HALF_HOUR });
    crashed.worker.crash({ code: 1, signal: null, cause: "exit_code" });
    await crashed.clock.advance(0);
    expect(crashed.clock.pending()).toBe(baseline.clock.pending());
  });

  it("clears its timer as soon as stop() is called, before the worker has exited", async () => {
    const baseline = setup({ idleMs: 0, holdShutdown: true });
    void baseline.live.stop();
    await baseline.clock.advance(0);
    const { clock, live } = setup({ idleMs: HALF_HOUR, holdShutdown: true });
    void live.stop();
    await clock.advance(0);
    expect(clock.pending()).toBe(baseline.clock.pending());
  });

  it("shows cold with no cause for a stop the daemon asked for (shutdownAll), and keeps oom's", async () => {
    const stopped = setup();
    await stopped.live.stop();
    expect(statuses(stopped.published).at(-1)).toEqual({ kind: "status", status: "cold" });

    const oom = setup({ idleMs: HALF_HOUR, holdShutdown: true });
    await oom.clock.advance(HALF_HOUR);
    oom.worker.crash({ code: null, signal: "SIGKILL", cause: "oom" });
    await oom.clock.advance(0);
    expect(statuses(oom.published).slice(-2)).toEqual([
      { kind: "status", status: "releasing" },
      {
        kind: "status",
        status: "cold",
        cause: "Agent process ran out of memory and was stopped.",
        causeCode: "process_oom",
      },
    ]);

    const crashed = setup();
    crashed.worker.crash({ code: 1, signal: null, cause: "exit_code" });
    await crashed.clock.advance(0);
    expect(statuses(crashed.published).at(-1)).toMatchObject({ status: "cold", cause: expect.any(String) });
  });

  it("says it is stopping from the moment a release or a stop begins, whatever the status shows", async () => {
    const released = setup({ idleMs: HALF_HOUR, holdShutdown: true });
    expect(released.live.stopping()).toBe(false);
    await released.clock.advance(HALF_HOUR);
    released.worker.emit(piEvent({ type: "agent_start" }));
    expect(released.live.status()).toBe("running");
    expect(released.live.stopping()).toBe(true);
    const stopped = setup({ holdShutdown: true });
    void stopped.live.stop();
    expect(stopped.live.stopping()).toBe(true);
    expect(stopped.live.status()).toBe("idle");
  });

  it("exited() resolves after the exit has been handled, also when the exit is not the release's", async () => {
    const { clock, worker, live, exits } = setup({ idleMs: HALF_HOUR, holdShutdown: true });
    await clock.advance(HALF_HOUR);
    expect(live.status()).toBe("releasing");
    let done = false;
    void live.exited().then(() => void (done = true));
    await clock.advance(0);
    expect(done).toBe(false);
    worker.crash({ code: 0, signal: null, cause: "clean" });
    await live.exited();
    expect(exits).toHaveLength(1);
    expect(live.status()).toBe("cold");
  });

  it("never sends a prompt, a command or a queue request to a worker that is stopping (M2-RT-39)", async () => {
    const { clock, worker, live } = setup({ idleMs: HALF_HOUR, holdShutdown: true });
    await clock.advance(HALF_HOUR);
    expect(live.status()).toBe("releasing");
    expect(await codeOf(live.prompt("late"))).toBe("worker_failed");
    expect(await codeOf(live.command({ type: "set_session_name", name: "n" }))).toBe("worker_failed");
    expect(await live.clearQueue()).toEqual({ steering: [], followUp: [], truncated: false });
    await live.abort();
    expect(worker.requests).toEqual([]);
    expect(worker.sent.map((record) => record.type)).toEqual(["init", "shutdown"]);
  });
});
