import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { captureLogger } from "./testing/helpers.ts";
import { confirm, createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

const aborts = (worker: { requests: Array<{ type: string }> }) =>
  worker.requests.filter((request) => request.type === "abort").length;
const idOf = (worker: { requests: Array<{ type: string; id: string }> }, type: string, nth = 0) =>
  worker.requests.filter((request) => request.type === type)[nth]?.id ?? "";

describe("abort while a prompt is in flight", () => {
  it("aborts at agent_start when Stop came while the prompt was still in flight (R113)", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const prompted = live.prompt("go");
    await clock.advance(0);
    const promptId = worker.requests.find((r) => r.type === "prompt")?.id ?? "";
    await live.abort();
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(1);
    worker.respond(promptId, { data: { disposition: "started" } });
    await prompted;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(2);
  });

  it("forgets that abort when the prompt started nothing", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const prompted = live.prompt("/handled-command");
    await clock.advance(0);
    const promptId = worker.requests.find((r) => r.type === "prompt")?.id ?? "";
    await live.abort();
    worker.respond(promptId, { data: { disposition: "handled" } });
    await prompted;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(1);
  });

  it("keeps the memory while another prompt is still in flight", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const first = live.prompt("one");
    const second = live.prompt("two");
    await clock.advance(0);
    const [firstId, secondId] = worker.requests.filter((r) => r.type === "prompt").map((r) => r.id);
    await live.abort();
    worker.respond(firstId ?? "", { data: { disposition: "handled" } });
    await first;
    worker.respond(secondId ?? "", { data: { disposition: "started" } });
    await second;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(2);
  });
});

describe("run origin", () => {
  it("records who started a run", async () => {
    const { live, worker, recorded, clock } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(0);
    await live.prompt("hi");
    worker.emit(piEvent({ type: "agent_start" }));
    expect(recorded.filter(([kind]) => kind === "run_start").map(([, data]) => data)).toEqual([
      { origin: "extension" },
      { origin: "user" },
    ]);
  });
});

describe("the remembered abort belongs to its prompts (R113)", () => {
  it.each([
    ["started, then handled", ["started", "handled"]],
    ["handled, then started", ["handled", "started"]],
  ] as const)(
    "still aborts the run of the prompt that started when the answers come %s",
    async (_label, order) => {
      const { live, worker, clock } = setup({ holdPrompt: true });
      const first = live.prompt("a");
      await clock.advance(0);
      await live.abort();
      const second = live.prompt("b");
      await clock.advance(0);
      const answers = { a: idOf(worker, "prompt", 0), b: idOf(worker, "prompt", 1) };
      const reply = (who: "a" | "b", disposition: string) =>
        worker.respond(answers[who], { data: { disposition } });
      // `a` is the prompt that starts, `b` the one that does not; the label gives the order they are answered in.
      const [firstAnswer] = order;
      if (firstAnswer === "started") {
        reply("a", "started");
        reply("b", "handled");
      } else {
        reply("b", "handled");
        reply("a", "started");
      }
      await Promise.all([first, second]);
      expect(aborts(worker)).toBe(1);
      worker.emit(piEvent({ type: "agent_start" }));
      await clock.advance(0);
      expect(aborts(worker)).toBe(2);
    },
  );

  it("sends exactly one abort between the answer and agent_start", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const prompted = live.prompt("go");
    await clock.advance(0);
    await live.abort();
    worker.respond(idOf(worker, "prompt"), { data: { disposition: "started" } });
    await prompted;
    await clock.advance(0);
    expect(aborts(worker)).toBe(1);
  });

  it("aborts when Stop comes after the answer `started` and before agent_start", async () => {
    const { live, worker } = setup();
    await live.prompt("go");
    await live.abort();
    expect(aborts(worker)).toBe(1);
    worker.emit(piEvent({ type: "agent_start" }));
    await Promise.resolve();
    expect(aborts(worker)).toBe(2);
  });

  it("drops the memory when no agent_start follows a `started` within the abort deadline", async () => {
    const { logger, lines } = captureLogger();
    const { live, worker, clock } = setup({ holdPrompt: true, logger });
    const prompted = live.prompt("go");
    await clock.advance(0);
    await live.abort();
    worker.respond(idOf(worker, "prompt"), { data: { disposition: "started" } });
    await prompted;
    await clock.advance(5000);
    expect(lines.filter((line) => line.msg === "abort_at_start_expired")).toHaveLength(1);
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(aborts(worker)).toBe(1);
  });

  it("still aborts when agent_start comes just before the deadline", async () => {
    const { logger, lines } = captureLogger();
    const { live, worker, clock } = setup({ holdPrompt: true, logger });
    const prompted = live.prompt("go");
    await clock.advance(0);
    await live.abort();
    worker.respond(idOf(worker, "prompt"), { data: { disposition: "started" } });
    await prompted;
    await clock.advance(4999);
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(aborts(worker)).toBe(2);
    // The deadline went with the run start: it does not fire later.
    await clock.advance(5000);
    expect(lines.filter((line) => line.msg === "abort_at_start_expired")).toEqual([]);
  });

  it("leaves no timer behind once the run has started, or the worker is gone", async () => {
    const started = setup();
    await started.live.prompt("go");
    expect(started.clock.pending()).toBe(1);
    started.worker.emit(piEvent({ type: "agent_start" }));
    expect(started.clock.pending()).toBe(0);
    const gone = setup();
    await gone.live.prompt("go");
    gone.worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await gone.clock.advance(0);
    expect(gone.clock.pending()).toBe(0);
  });

  it("arms the memory in the idle branch too, when a prompt is in flight and the daemon holds a stale run open", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    worker.emit(piEvent({ type: "agent_start" }));
    const prompted = live.prompt("go");
    await clock.advance(0);
    await live.abort();
    expect(live.status()).toBe("idle");
    expect(aborts(worker)).toBe(1);
    worker.respond(idOf(worker, "prompt"), { data: { disposition: "started" } });
    await prompted;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(aborts(worker)).toBe(2);
  });
});

describe("run origin after input that started nothing", () => {
  it("is an extension's after a command that was handled", async () => {
    const { logger, lines } = captureLogger();
    const { live, worker, recorded, clock } = setup({ disposition: "handled", logger });
    await live.prompt("/command");
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(recorded.filter(([kind]) => kind === "run_start").map(([, data]) => data)).toEqual([
      { origin: "extension" },
    ]);
    expect(lines.filter((line) => line.msg === "run_started_by_extension")).toHaveLength(1);
  });

  it("is an extension's after a steer that was queued in the previous run", async () => {
    const { logger, lines } = captureLogger();
    const { live, worker, recorded, clock } = setup({ holdPrompt: true, logger });
    const first = live.prompt("a");
    await clock.advance(0);
    worker.respond(idOf(worker, "prompt", 0), { data: { disposition: "started" } });
    await first;
    worker.emit(piEvent({ type: "agent_start" }));
    const steer = live.prompt("b", "steer");
    await clock.advance(0);
    worker.respond(idOf(worker, "prompt", 1), { data: { disposition: "queued" } });
    await steer;
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(0);
    worker.emit(piEvent({ type: "agent_start" }));
    expect(recorded.filter(([kind]) => kind === "run_start").map(([, data]) => data)).toEqual([
      { origin: "user" },
      { origin: "extension" },
    ]);
    expect(lines.filter((line) => line.msg === "run_started_by_extension")).toHaveLength(1);
  });

  it("is the user's when agent_start comes before the answer of the prompt", async () => {
    const { live, worker, recorded, clock } = setup({ holdPrompt: true });
    const prompted = live.prompt("go");
    await clock.advance(0);
    worker.emit(piEvent({ type: "agent_start" }));
    worker.respond(idOf(worker, "prompt"), { data: { disposition: "started" } });
    await prompted;
    expect(recorded.filter(([kind]) => kind === "run_start").map(([, data]) => data)).toEqual([
      { origin: "user" },
    ]);
  });
});

describe("probe failures are logged", () => {
  it("logs a get_state the run tracker could not get", async () => {
    const { logger, lines } = captureLogger();
    const { worker, clock, pi } = setup({ logger });
    pi.holdState = true;
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(2000);
    expect(lines.filter((line) => line.msg === "worker_request_failed")).toContainEqual(
      expect.objectContaining({ command: "get_state", code: "timeout", level: "debug" }),
    );
  });

  it("logs the get_state that failed before it stops the worker", async () => {
    const { logger, lines } = captureLogger();
    const { live, worker, clock, pi } = setup({ logger });
    worker.emit(piEvent({ type: "agent_start" }));
    pi.holdState = true;
    const aborting = live.abort();
    await clock.advance(2000);
    await aborting;
    expect(worker.stopped()).toBe(true);
    expect(lines.filter((line) => line.msg === "worker_request_failed")).toContainEqual(
      expect.objectContaining({ command: "get_state", code: "timeout" }),
    );
  });

  it("logs an abort the worker could not take because it was gone", async () => {
    const { logger, lines } = captureLogger();
    const { live, worker, clock } = setup({ holdPrompt: true, logger });
    const prompted = live.prompt("go").catch(() => undefined);
    await clock.advance(0);
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await live.abort();
    await prompted;
    expect(lines.filter((line) => line.msg === "worker_request_failed")).toContainEqual(
      expect.objectContaining({ command: "abort", code: "worker_failed", level: "debug" }),
    );
  });
});

describe("streamed text", () => {
  const text = (delta: string) =>
    piEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  const startReply = (worker: { emit(record: unknown): void }) => {
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
    worker.emit(
      piEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
    );
  };
  const deltasOf = (published: Array<{ kind: string; event?: unknown }>) =>
    published.flatMap((event) =>
      event.kind === "pi"
        ? [
            ((event.event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta ??
              "") as string,
          ]
        : [],
    );

  it("puts only published deltas in the snapshot's partial reply", async () => {
    const { live, worker, clock } = setup();
    startReply(worker);
    worker.emit(text("ab"));
    expect(live.partial()).toEqual({ blocks: [{ type: "text", text: "" }] });
    await clock.advance(50);
    expect(live.partial()).toEqual({ blocks: [{ type: "text", text: "ab" }] });
  });

  it("leaves a delta too large to stream out of the partial reply as well", async () => {
    const { live, worker, published, clock } = setup();
    startReply(worker);
    worker.emit(text("x".repeat(1_100_000)));
    worker.emit(text("ok"));
    await clock.advance(50);
    expect(deltasOf(published).filter(Boolean)).toEqual(["ok"]);
    expect(live.partial()).toEqual({ blocks: [{ type: "text", text: "ok" }] });
  });

  it("sends pending deltas before any other event it publishes", async () => {
    const { worker, published, clock } = setup();
    worker.emit(piEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
    worker.emit(text("before the question"));
    worker.emit(confirm);
    await clock.advance(0);
    const kinds = published.map((event) =>
      event.kind === "pi"
        ? ((event.event.assistantMessageEvent as { delta?: string } | undefined)?.delta ?? event.event.type)
        : event.kind,
    );
    expect(kinds.indexOf("before the question")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("before the question")).toBeLessThan(kinds.indexOf("dialog_open"));
  });

  it("sends pending deltas before an extension's notification and before the end of the run", async () => {
    const { worker, published, clock } = setup();
    startReply(worker);
    worker.emit(text("x"));
    worker.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
    worker.emit(text("y"));
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(0);
    const order = published.map((event) =>
      event.kind === "pi"
        ? ((event.event.assistantMessageEvent as { delta?: string } | undefined)?.delta ?? event.event.type)
        : event.kind,
    );
    expect(order.slice(order.indexOf("x"))).toEqual(["x", "notice", "y", "agent_settled", "status"]);
  });

  it("publishes the merged text once and ends the partial reply with the message", async () => {
    const { live, worker, published, clock } = setup();
    startReply(worker);
    for (const piece of ["a", "b", "c"]) worker.emit(text(piece));
    worker.emit(piEvent({ type: "message_end", message: { role: "assistant", content: [] } }));
    expect(deltasOf(published).filter(Boolean)).toEqual(["abc"]);
    expect(live.partial()).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("sends what is pending when the worker exits, forgets the partial reply and arms nothing", async () => {
    const { live, worker, published, clock } = setup();
    startReply(worker);
    worker.emit(text("last words"));
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await clock.advance(0);
    const kinds = published.map((event) => (event.kind === "pi" ? "pi" : event.kind));
    expect(deltasOf(published)).toContain("last words");
    expect(kinds.lastIndexOf("pi")).toBeLessThan(kinds.lastIndexOf("status"));
    expect(live.partial()).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});
