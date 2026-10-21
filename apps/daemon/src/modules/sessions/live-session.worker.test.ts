import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { startLiveSession } from "./live-session.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { createLiveBed, INIT, piEvent, READY } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

describe("abort", () => {
  it("terminates the worker when abort meets compaction or no settle within 5 s", async () => {
    const compacting = setup({ compacting: true });
    compacting.worker.emit(piEvent({ type: "agent_start" }));
    await compacting.live.abort();
    expect(compacting.worker.stopped()).toBe(true);
    const stuck = setup({ streaming: true });
    stuck.worker.emit(piEvent({ type: "agent_start" }));
    const pending = stuck.live.abort();
    await stuck.clock.advance(4999);
    expect(stuck.worker.stopped()).toBe(false);
    await stuck.clock.advance(1);
    await pending;
    expect(stuck.worker.stopped()).toBe(true);
  });

  it("leaves the worker alone when the run settles in time", async () => {
    const { worker, live, clock, pi } = setup({ streaming: true });
    worker.emit(piEvent({ type: "agent_start" }));
    const aborting = live.abort();
    await clock.advance(0);
    expect(worker.requests.some((request) => request.type === "abort")).toBe(true);
    pi.streaming = false;
    worker.emit(piEvent({ type: "agent_settled", aborted: true }));
    await clock.advance(0);
    await aborting;
    expect(worker.stopped()).toBe(false);
    expect(live.status()).toBe("idle");
  });

  it("ends a run Pi is not running, tells Pi anyway, and leaves the worker alone (R111, R111b)", async () => {
    const { worker, live, clock, recorded, published } = setup();
    // The run Pi reported but never settled: input it rejected or handled, so no agent_settled will come.
    worker.emit(piEvent({ type: "agent_start" }));
    expect(live.status()).toBe("running");
    await live.abort();
    expect(live.status()).toBe("idle");
    expect(published.at(-1)).toEqual({ kind: "status", status: "idle" });
    expect(recorded.at(-1)).toEqual(["run_end", { aborted: true }]);
    // Pi is asked to abort whatever the answer was: it is a no-op for an idle Pi, and the right thing if the answer was stale.
    expect(worker.requests.some((request) => request.type === "abort")).toBe(true);
    await clock.advance(60_000);
    expect(worker.stopped()).toBe(false);
  });

  it("never ends a run that began while it was asking, however the records arrive (R111b)", async () => {
    const { worker, live, clock, pi, recorded } = setup({ holdPrompt: true });
    pi.holdState = true;
    // A run is open (an extension's, or one whose end was not seen), so Stop takes the get_state path, not the R113 one.
    worker.emit(piEvent({ type: "agent_start" }));
    // The user presses Stop as the prompt goes out. Pi's answers come in one batch: get_state (idle, as it was when
    // asked), the prompt's `started`, then agent_start. Node delivers each record before the continuation of the
    // response before it, so abort() resumes after all three.
    const prompt = live.prompt("go");
    const aborting = live.abort();
    const id = (type: string) => worker.requests.find((request) => request.type === type)?.id ?? "";
    worker.respond(id("get_state"), {
      data: {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: "/f",
        sessionId: "s1",
      },
    });
    worker.respond(id("prompt"), { data: { disposition: "started" } });
    worker.emit(piEvent({ type: "agent_start" }));
    await Promise.all([prompt, aborting]);
    await clock.advance(0);
    expect(live.status()).toBe("running");
    expect(recorded).toEqual([["run_start", { origin: "extension" }]]);
    // Pi was told to stop, and that is what ends the run.
    expect(worker.requests.some((request) => request.type === "abort")).toBe(true);
    pi.holdState = false;
    worker.emit(piEvent({ type: "agent_settled", aborted: true }));
    await clock.advance(0);
    expect(live.status()).toBe("idle");
    expect(worker.stopped()).toBe(false);
  });

  it("does nothing to a session that is idle", async () => {
    const { worker, live, recorded } = setup();
    await live.abort();
    expect(worker.stopped()).toBe(false);
    expect(live.status()).toBe("idle");
    expect(recorded).toEqual([]);
  });

  it("terminates a worker that does not answer get_state", async () => {
    const clock = createFakeClock();
    const worker = createFakeWorker({ clock });
    const live = startLiveSession(
      {
        handle: worker,
        clock,
        logger: silentLogger,
        publish: () => {},
        record: () => {},
        onActivity: () => {},
        onExit: () => {},
        onName: () => {},
        idleMs: 0,
      },
      INIT,
    );
    worker.emit(READY);
    const aborting = live.abort();
    await clock.advance(2000);
    await aborting;
    expect(worker.stopped()).toBe(true);
  });
});

describe("prompt", () => {
  it("maps a rejected prompt to prompt_rejected and never forwards the worker's text", async () => {
    const { logger, lines } = captureLogger();
    const { live } = setup({ promptFails: true, logger });
    expect(await codeOf(live.prompt("go"))).toBe("prompt_rejected");
    expect(lines.find((line) => line.msg === "prompt_rejected")?.error).toBe("No API key for provider x");
  });

  it("starts, queues or hands the prompt over, as Pi says", async () => {
    const { live } = setup();
    expect(await live.prompt("go")).toEqual({ disposition: "started" });
  });

  it("fails with worker_failed, not timeout, when the worker dies while the prompt waits", async () => {
    const { worker, live } = setup({ holdPrompt: true });
    const prompt = codeOf(live.prompt("/ask"));
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    expect(await prompt).toBe("worker_failed");
  });
});

describe("extension errors", () => {
  const error = {
    type: "extension_error" as const,
    extensionPath: "/home/u/ext.ts",
    event: "tool_call",
    error: "TOKEN=abc123",
  };

  it("tells the user in fixed words and logs the worker's, clipped", () => {
    const { logger, lines } = captureLogger();
    const { worker, published } = setup({ logger });
    worker.emit({ ...error, error: `${"e".repeat(5000)}` });
    expect(published.at(-1)).toEqual({
      kind: "notice",
      level: "error",
      text: "An extension (ext.ts) failed during tool_call.",
      code: "extension_failed_named",
      params: { event: "tool_call", extension: "ext.ts" },
    });
    expect(String(lines.find((line) => line.msg === "extension_error")?.error).length).toBeLessThanOrEqual(
      2001,
    );
  });

  it("never sends the worker's text to a client", () => {
    const { worker, published } = setup();
    worker.emit(error);
    worker.emit({ ...error, event: "see /etc/passwd now" });
    expect(JSON.stringify(published)).not.toMatch(/abc123|passwd|\/home\/u/);
    expect(published.at(-1)).toEqual({
      kind: "notice",
      level: "error",
      text: "An extension failed.",
      code: "extension_failed",
    });
  });
});

describe("a run left open by a prompt that started nothing (R111b)", () => {
  it.each([
    ["rejected", { promptFails: true }],
    ["handled", { disposition: "handled" as const }],
  ])("is ended once the prompt is answered %s and Pi shows nothing running", async (_label, options) => {
    const { worker, live, clock, recorded } = setup(options);
    worker.emit(piEvent({ type: "agent_start" }));
    expect(live.status()).toBe("running");
    await live.prompt("/command").catch(() => undefined);
    await clock.advance(0);
    expect(live.status()).toBe("idle");
    expect(recorded.at(-1)).toEqual(["run_end", { aborted: false }]);
    expect(worker.stopped()).toBe(false);
  });

  it("stays open while Pi is still running, and when there was no run", async () => {
    const busy = setup({ disposition: "handled", streaming: true });
    busy.worker.emit(piEvent({ type: "agent_start" }));
    await busy.live.prompt("/command");
    await busy.clock.advance(0);
    expect(busy.live.status()).toBe("running");
    const none = setup({ disposition: "handled" });
    await none.live.prompt("/command");
    await none.clock.advance(0);
    expect(none.live.status()).toBe("idle");
    expect(none.recorded).toEqual([]);
    expect(none.worker.requests.some((request) => request.type === "get_state")).toBe(false);
  });

  it("does not end a run that began while it was looking", async () => {
    const { worker, live, clock, pi, recorded } = setup({ promptFails: true });
    worker.emit(piEvent({ type: "agent_start" }));
    pi.holdState = true;
    const rejected = live.prompt("x").catch(() => undefined);
    await clock.advance(0);
    const stateId = worker.requests.find((request) => request.type === "get_state")?.id ?? "";
    worker.respond(stateId, {
      data: {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: "/f",
        sessionId: "s1",
      },
    });
    worker.emit(piEvent({ type: "agent_start" }));
    await rejected;
    await clock.advance(0);
    expect(live.status()).toBe("running");
    expect(recorded).toEqual([["run_start", { origin: "extension" }]]);
  });
});
