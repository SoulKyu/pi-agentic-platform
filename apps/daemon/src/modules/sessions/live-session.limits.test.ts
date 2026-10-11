import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { captureLogger } from "./testing/helpers.ts";
import { confirm, createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);
const kindsOf = (events: Array<{ kind: string }>) => events.map((event) => event.kind);

describe("system messages stay inside the daemon (R107)", () => {
  const system = {
    role: "system",
    content: "",
    sections: { preamble: "You are an expert coding assistant" },
  };

  it("are neither sent as events nor kept for the snapshot of a run", () => {
    const { worker, live, published } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "message_start", message: system }));
    worker.emit(piEvent({ type: "message_end", message: system }));
    worker.emit(piEvent({ type: "message_end", message: { role: "user", content: "hi" } }));
    expect(live.runView()?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(JSON.stringify(published)).not.toContain("expert coding assistant");
    expect(JSON.stringify(published)).not.toContain('"role":"system"');
    const piTypes = published.flatMap((event) => (event.kind === "pi" ? [event.event.type] : []));
    expect(piTypes).toEqual(["agent_start", "message_end"]);
  });

  it("still count as Pi activity, which is how the daemon notices Pi's file", () => {
    const { worker, activity } = setup();
    worker.emit(piEvent({ type: "message_end", message: system }));
    expect(activity.count).toBe(1);
  });
});

describe("events too large for one frame", () => {
  const update = (type: string, extra: Record<string, unknown>) =>
    piEvent({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });

  it.each([
    ["text_end", { content: "x".repeat(1_100_000) }],
    [
      "toolcall_end",
      { toolCall: { id: "c1", name: "write", arguments: { content: "x".repeat(1_100_000) } } },
    ],
  ])("drops a %s that is, and says so", (type, extra) => {
    const { worker, published } = setup();
    worker.emit(update(type, extra));
    expect(published.at(-1)).toEqual({
      kind: "notice",
      level: "warning",
      text: "A message was too large to stream.",
    });
    expect(published.some((event) => event.kind === "pi")).toBe(false);
  });

  it("lets deltas and small ends through", () => {
    const { worker, published } = setup();
    worker.emit(update("text_delta", { delta: "Hi" }));
    worker.emit(update("text_end", { content: "Hi" }));
    expect(kindsOf(published)).toEqual(["status", "pi", "pi"]);
  });

  it("says so once every 10 s, however many there are, and logs the ones it did not say", async () => {
    const { logger, lines } = captureLogger();
    const { worker, published, clock } = setup({ logger });
    const huge = update("text_end", { content: "x".repeat(1_100_000) });
    for (let i = 0; i < 3; i++) worker.emit(huge);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(1);
    await clock.advance(10_000);
    worker.emit(huge);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(2);
    const logged = lines.filter((line) => line.msg === "pi_event_too_large");
    expect(logged).toHaveLength(2);
    expect(logged.at(-1)).toMatchObject({ suppressed: 2 });
  });
});

describe("rows too large for a snapshot (R109)", () => {
  it("are kept for the run as a placeholder that says what they were", () => {
    const { worker, live } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    const huge = { role: "toolResult", timestamp: 7, content: [{ type: "text", text: "x".repeat(300_000) }] };
    worker.emit(piEvent({ type: "message_end", message: huge }));
    worker.emit(piEvent({ type: "message_end", message: { role: "user", content: "hi" } }));
    const messages = live.runView()?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "toolResult",
      timestamp: 7,
      omitted: true,
      bytes: Buffer.byteLength(JSON.stringify(huge)),
    });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });
});

describe("dialogs the daemon cancels", () => {
  const tooMany = (id: string) => ({
    ...confirm,
    id,
    method: "select",
    options: Array.from({ length: 101 }, (_, i) => `option ${i}`),
  });

  it("are each answered, but the user and the log hear of them once every 10 s (R111)", async () => {
    const { logger, lines } = captureLogger();
    const { worker, published, clock } = setup({ logger });
    for (const id of ["a", "b", "c"]) worker.emit(tooMany(id));
    const cancels = () => worker.sent.filter((record) => record.type === "extension_ui_response");
    expect(cancels().map((record) => (record as { id: string }).id)).toEqual(["a", "b", "c"]);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(1);
    expect(lines.filter((line) => line.msg === "dialog_cancelled")).toHaveLength(1);
    await clock.advance(10_000);
    worker.emit(tooMany("d"));
    expect(cancels()).toHaveLength(4);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(2);
    expect(lines.filter((line) => line.msg === "dialog_cancelled").at(-1)).toMatchObject({ suppressed: 2 });
  });

  it("are counted apart by reason", () => {
    const { logger, lines } = captureLogger();
    const { worker } = setup({ logger });
    worker.emit(tooMany("a"));
    worker.emit({ ...confirm, id: "b", method: "custom" });
    expect(lines.filter((line) => line.msg === "dialog_cancelled").map((line) => line.reason)).toEqual([
      "too_large",
      "unknown_method",
    ]);
  });
});
