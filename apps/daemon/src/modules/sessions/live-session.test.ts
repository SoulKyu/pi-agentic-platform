import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READY_TIMEOUT_MS, startLiveSession } from "./live-session.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { confirm, createLiveBed, INIT, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

describe("live session start", () => {
  it("sends init first and reports idle on ready", async () => {
    const { worker, live, published } = setup();
    expect(worker.sent[0]).toEqual(INIT);
    expect((await live.ready).sessionId).toBe("s1");
    expect(live.status()).toBe("idle");
    expect(live.piFile()).toBe("/f");
    expect(live.piSessionId()).toBe("s1");
    expect(published).toContainEqual({ kind: "status", status: "idle" });
  });

  it("gives up on a worker that is not ready in time, and stops it", async () => {
    const { worker, live, clock } = setup({ neverReady: true });
    const outcome = codeOf(live.ready);
    await clock.advance(READY_TIMEOUT_MS - 1);
    expect(worker.stopped()).toBe(false);
    await clock.advance(1);
    expect(await outcome).toBe("worker_failed");
    expect(worker.stopped()).toBe(true);
  });

  it("fails the start when the worker exits first, which is what exit code 70 on a bad init looks like", async () => {
    const { worker, live, clock, published, exits } = setup({ neverReady: true });
    const outcome = codeOf(live.ready);
    worker.crash({ code: 70, signal: null, cause: "exit_code" });
    await clock.advance(0);
    expect(await outcome).toBe("worker_failed");
    expect(published.at(-1)).toEqual({
      kind: "status",
      status: "cold",
      cause: "Agent process exited with code 70.",
    });
    expect(exits).toHaveLength(1);
    // The ready timer went with the worker.
    expect(clock.pending()).toBe(0);
  });
});

describe("dialogs", () => {
  it("opens a card, forwards the answer once, and answering twice returns not_found", () => {
    const { worker, live, published } = setup();
    worker.emit(confirm);
    expect(published).toContainEqual({
      kind: "dialog_open",
      dialog: { id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" },
    });
    live.answer("d1", { confirmed: true });
    expect(worker.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: true });
    expect(published.at(-1)).toEqual({ kind: "dialog_closed", id: "d1" });
    expect(() => live.answer("d1", { confirmed: true })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("closes the card, and says so, when the answer cannot reach a worker that is going away", () => {
    const { worker, live, published } = setup();
    worker.emit(confirm);
    void live.stop();
    expect(() => live.answer("d1", { confirmed: true })).toThrow(
      expect.objectContaining({ code: "worker_failed" }),
    );
    expect(published.at(-1)).toEqual({ kind: "dialog_closed", id: "d1" });
  });

  it("removes a card the worker closed on its own", () => {
    const { worker, live, published } = setup();
    worker.emit(confirm);
    worker.emit({ type: "extension_ui_closed", id: "d1" });
    expect(published.at(-1)).toEqual({ kind: "dialog_closed", id: "d1" });
    expect(live.dialogs()).toEqual([]);
    worker.emit({ type: "extension_ui_closed", id: "d1" });
    expect(published.filter((event) => event.kind === "dialog_closed")).toHaveLength(1);
  });

  it("cancels unknown dialog methods at once, without a card and without a notice", () => {
    const { worker, published } = setup();
    worker.emit({ ...confirm, id: "x1", method: "custom" });
    expect(worker.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "x1", cancelled: true });
    expect(published.map((event) => event.kind)).toEqual(["status"]);
  });

  it("cancels a dialog that cannot be shown and tells the user why", () => {
    const { worker, published } = setup();
    worker.emit({
      ...confirm,
      id: "big",
      method: "select",
      options: Array.from({ length: 101 }, (_, i) => `option ${i}`),
    });
    expect(worker.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "big", cancelled: true });
    expect(published.at(-1)).toEqual({
      kind: "notice",
      level: "warning",
      text: "An extension asked a question that was too large to show. It was cancelled.",
    });
  });

  it("sends a dialog whole enough for one frame, however much the extension put in it", () => {
    const { worker, published } = setup();
    worker.emit({ ...confirm, id: "e1", method: "editor", prefill: "x".repeat(3_000_000) });
    const opened = published.find((event) => event.kind === "dialog_open");
    expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThan(1024 * 1024 - 1024);
  });

  it("passes decorations on as Pi events", () => {
    const { worker, published } = setup();
    const notify = { type: "extension_ui_request" as const, id: "n1", method: "notify", message: "hi" };
    worker.emit(notify);
    expect(published.at(-1)).toEqual({ kind: "pi", event: notify });
  });

  it("answers a dialog while a prompt that waits for it is still pending, and the prompt then completes", async () => {
    const { worker, live, clock } = setup({ holdPrompt: true });
    const prompt = live.prompt("/ask");
    worker.emit(confirm);
    live.answer("d1", { confirmed: true });
    expect(worker.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: true });
    const promptId = worker.requests.find((request) => request.type === "prompt")?.id ?? "";
    // An extension command answers only when it ends, however long that takes (R99).
    await clock.advance(60 * 60 * 1000);
    worker.respond(promptId, { data: { disposition: "handled" } });
    expect(await prompt).toEqual({ disposition: "handled" });
  });
});

describe("runs", () => {
  it("records a run from agent_start to a confirmed agent_settled", async () => {
    const { worker, live, clock, recorded } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    expect(live.status()).toBe("running");
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(0);
    expect(live.status()).toBe("idle");
    expect(recorded).toEqual([
      ["run_start", { origin: "extension" }],
      ["run_end", { aborted: false }],
    ]);
  });

  it("keeps what a run has produced for a snapshot until the run has settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-live-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, "12345");
      const { worker, live, clock } = setup({ sessionFile: file });
      expect(live.runView()).toBeNull();
      worker.emit(piEvent({ type: "agent_start" }));
      worker.emit(piEvent({ type: "message_end", message: { role: "user", content: "hi" } }));
      worker.emit(piEvent({ type: "message_update", message: { role: "assistant" } }));
      expect(live.runView()).toEqual({ baselineBytes: 5, messages: [{ role: "user", content: "hi" }] });
      worker.emit(piEvent({ type: "agent_settled", aborted: false }));
      await clock.advance(0);
      expect(live.runView()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards Pi events as they are and tells the service after each", () => {
    const { worker, published, activity } = setup();
    const delta = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } };
    worker.emit(piEvent(delta));
    expect(published.at(-1)).toEqual({ kind: "pi", event: delta });
    expect(activity.count).toBe(1);
  });

  it("replaces an event too large for one frame with a notice", () => {
    const { worker, published } = setup();
    worker.emit(
      piEvent({ type: "message_end", message: { role: "assistant", content: "x".repeat(1_100_000) } }),
    );
    expect(published.at(-1)).toEqual({
      kind: "notice",
      level: "warning",
      text: "A message was too large to stream.",
    });
    expect(published.some((event) => event.kind === "pi")).toBe(false);
  });

  it("records the worker's audit entries as policy events", () => {
    const { worker, recorded } = setup();
    const entry = {
      toolCallId: "c1",
      tool: "bash",
      category: "exec" as const,
      decision: "approved" as const,
    };
    worker.emit({ type: "audit", entry });
    expect(recorded).toEqual([["policy", entry]]);
  });

  it("remembers the worker's memory use", () => {
    const { worker, live } = setup();
    expect(live.rssMb()).toBeNull();
    worker.emit({ type: "health", rssMb: 156 });
    expect(live.rssMb()).toBe(156);
  });
});

describe("a worker that goes away", () => {
  it("closes open dialogs and records an interrupted run", async () => {
    const { worker, live, clock, published, recorded, exits, activity } = setup();
    worker.emit(confirm);
    worker.emit(piEvent({ type: "agent_start" }));
    const before = activity.count;
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await clock.advance(0);
    expect(published).toContainEqual({ kind: "dialog_closed", id: "d1" });
    expect(published.at(-1)).toEqual({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
    expect(recorded).toContainEqual(["run_end", { interrupted: "killed" }]);
    expect(recorded).toContainEqual(["worker_exit", { code: null, signal: "SIGKILL", cause: "killed" }]);
    expect(live.dialogs()).toEqual([]);
    expect(live.runView()).toBeNull();
    expect(activity.count).toBeGreaterThan(before);
    expect(exits).toHaveLength(1);
  });

  it("logs the end of the worker's output, clipped to 2 KB, and nothing else it wrote", async () => {
    const { logger, lines } = captureLogger();
    const { worker, clock } = setup({ logger });
    worker.outputTail = () => `${"A".repeat(8000)}the last words`;
    worker.crash({ code: 1, signal: null, cause: "exit_code" });
    await clock.advance(0);
    const logged = lines.find((line) => line.msg === "worker_exited");
    const output = String(logged?.output);
    expect(output.endsWith("the last words")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(2000);
  });
});
