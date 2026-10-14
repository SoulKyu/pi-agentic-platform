import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { fitSnapshot } from "./snapshot.ts";
import { captureLogger } from "./testing/helpers.ts";
import { confirm, createLiveBed } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);
type Bed = ReturnType<typeof setup>;

const NOTICE = "A question about a tool call could not be shown. The call was blocked.";
const ask = (id: string, key: string, message = "bash: ls", fields: Record<string, unknown> = {}) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message,
  answers: ["deny", "once"] as Array<"deny" | "once">,
  tool: "bash",
  key,
  tainted: false,
  ...fields,
});
const KEY = "c".repeat(64);
const responses = (worker: Bed["worker"]) =>
  worker.sent.filter(
    (record) => record.type === "approval_response" || record.type === "extension_ui_response",
  );
const notices = (published: Bed["published"]) =>
  published.flatMap((event) => (event.kind === "notice" ? [event.text] : []));
const codes = (published: Bed["published"]) =>
  published.flatMap((event) => (event.kind === "notice" ? [event.code] : []));
const cancelled = (id: string) => ({ type: "approval_response", id, answer: "deny", cancelled: true });

describe("answering an approval", () => {
  it("answers with the policy's record, mapping the M1 answers", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", KEY));
    worker.emit(ask("a2", "d".repeat(64), "bash: pwd"));
    await clock.advance(0);
    live.answer("a1", { confirmed: true });
    expect(() => live.answer("a2", { answer: "always" })).toThrow(new PapError("bad_request"));
    live.answer("a2", { answer: "deny" });
    expect(responses(worker)).toEqual([
      { type: "approval_response", id: "a1", answer: "once" },
      { type: "approval_response", id: "a2", answer: "deny" },
    ]);
  });

  it("leaves the dialog open after a bad answer, and takes nothing (M2R61)", async () => {
    const { live, worker, clock, published } = setup();
    worker.emit(ask("a1", KEY));
    await clock.advance(0);
    for (const bad of [{ answer: "always" as const }, { answer: "session" as const }, { value: "yes" }]) {
      expect(() => live.answer("a1", bad)).toThrow(new PapError("bad_request"));
    }
    expect(live.dialogs().map((dialog) => dialog.id)).toEqual(["a1"]);
    expect(responses(worker)).toEqual([]);
    expect(published.filter((event) => event.kind === "dialog_closed")).toEqual([]);
    live.answer("a1", { answer: "once" });
    expect(live.dialogs()).toEqual([]);
  });

  it("returns the answer and the grant for the approval, once", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", KEY, "bash: ls"));
    await clock.advance(0);
    expect(live.answer("a1", { answer: "once" })).toEqual({
      answer: "once",
      scope: "exact",
      grant: { tool: "bash", key: KEY, label: "bash: ls" },
    });
    expect(() => live.answer("a1", { answer: "once" })).toThrow(new PapError("not_found"));
  });

  it("maps a refusal and a dismissed card to a plain deny, the user's own answer (M2R61)", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", KEY));
    worker.emit(ask("a2", "d".repeat(64)));
    await clock.advance(0);
    expect(live.answer("a1", { confirmed: false })?.answer).toBe("deny");
    expect(live.answer("a2", { cancelled: true })?.answer).toBe("deny");
    expect(responses(worker)).toEqual([
      { type: "approval_response", id: "a1", answer: "deny" },
      { type: "approval_response", id: "a2", answer: "deny" },
    ]);
  });

  it("lets a dismissed card refuse even when the card does not offer deny: the person can always say no", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", KEY, "bash: ls", { answers: ["once", "session"] }));
    await clock.advance(0);
    expect(live.answer("a1", { cancelled: true })?.answer).toBe("deny");
    expect(responses(worker)).toEqual([{ type: "approval_response", id: "a1", answer: "deny" }]);
  });

  it("refuses a confirm or a refusal the card does not offer, and leaves the card open", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", KEY, "bash: ls", { answers: ["deny", "always"] }));
    worker.emit(ask("a2", "d".repeat(64), "bash: pwd", { answers: ["once", "session"] }));
    await clock.advance(0);
    expect(() => live.answer("a1", { confirmed: true })).toThrow(new PapError("bad_request"));
    expect(() => live.answer("a2", { confirmed: false })).toThrow(new PapError("bad_request"));
    expect(live.dialogs().map((dialog) => dialog.id)).toEqual(["a1", "a2"]);
    expect(responses(worker)).toEqual([]);
    expect(live.answer("a1", { confirmed: false })?.answer).toBe("deny");
    expect(live.answer("a2", { confirmed: true })?.answer).toBe("once");
  });

  it("refuses an approval answer for an extension's confirm", async () => {
    const { live, worker, clock } = setup();
    worker.emit(confirm);
    await clock.advance(0);
    expect(() => live.answer(confirm.id, { answer: "once" })).toThrow(new PapError("bad_request"));
    expect(live.dialogs()).toHaveLength(1);
    live.answer(confirm.id, { confirmed: true });
    expect(responses(worker)).toEqual([{ type: "extension_ui_response", id: confirm.id, confirmed: true }]);
  });
});

describe("an approval the daemon cannot show", () => {
  it("is answered as cancelled, never as the user's refusal (M2-RT-22)", async () => {
    const { worker, clock, published } = setup();
    // 64 open dialogs is the registry's limit (spec C §2.4): the 65th question, an approval, cannot be shown.
    for (let i = 0; i < 64; i++) worker.emit({ ...confirm, id: `d${i}` });
    worker.emit(ask("a1", KEY));
    await clock.advance(0);
    expect(responses(worker)).toEqual([cancelled("a1")]);
    expect(published.filter((event) => event.kind === "dialog_open" && event.dialog.id === "a1")).toEqual([]);
    expect(notices(published)).toEqual([NOTICE]);
    expect(codes(published)).toEqual(["approval_unshown"]);
  });

  // Through the real parser: this is what reaches the live session from a worker process.
  it.each([
    ["empty answers", { answers: [] }],
    ["missing answers", { answers: undefined }],
    ["an unknown answer", { answers: ["deny", "forever"] }],
    ["no category", { category: undefined }],
    ["a 65 537-character message", { message: "x".repeat(65_537) }],
    ["a 257-character tool", { tool: "t".repeat(257) }],
    ["a non-hex key", { key: "not-hex" }],
  ])("is answered as cancelled when it has %s", async (_name, fields) => {
    const { live, worker, clock, published } = setup();
    worker.emitRaw(ask("a1", KEY, "bash: ls", fields));
    await clock.advance(0);
    expect(responses(worker)).toEqual([cancelled("a1")]);
    expect(live.dialogs()).toEqual([]);
    expect(published.filter((event) => event.kind === "dialog_open")).toEqual([]);
    expect(notices(published)).toEqual([NOTICE]);
  });

  it("withdraws an open approval of the same id, so no dead card is left to answer twice", async () => {
    const { live, worker, clock, published } = setup();
    worker.emit(ask("a1", KEY));
    worker.emitRaw(ask("a1", KEY, "bash: ls", { answers: [] }));
    await clock.advance(0);
    expect(live.dialogs()).toEqual([]);
    expect(published.filter((event) => event.kind === "dialog_closed")).toEqual([
      { kind: "dialog_closed", id: "a1" },
    ]);
    expect(responses(worker)).toEqual([cancelled("a1")]);
    expect(() => live.answer("a1", { answer: "once" })).toThrow(new PapError("not_found"));
    expect(responses(worker)).toEqual([cancelled("a1")]);
  });

  it("keeps an open extension dialog of the same id (probe P2)", async () => {
    const { live, worker, clock, published } = setup();
    worker.emit(confirm);
    worker.emitRaw(ask(confirm.id, KEY, "bash: ls", { answers: [] }));
    await clock.advance(0);
    expect(live.dialogs().map((dialog) => dialog.method)).toEqual(["confirm"]);
    expect(responses(worker)).toEqual([cancelled(confirm.id)]);
    expect(published.filter((event) => event.kind === "dialog_closed")).toEqual([]);
  });

  it("logs the cancellation once with a stable code and fixed fields only", async () => {
    const { logger, lines } = captureLogger();
    const { worker, clock } = setup({ logger });
    worker.emitRaw(ask("a1", KEY, "secret text", { answers: [] }));
    worker.emitRaw(ask("a2", KEY, "secret text", { answers: [] }));
    await clock.advance(0);
    const logged = lines.filter(
      (line) => line.msg === "dialog_cancelled" || line.event === "dialog_cancelled",
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ reason: "malformed", method: "approval", suppressed: 0 });
    expect(JSON.stringify(lines)).not.toContain("secret text");
  });

  it("is dropped when it has no usable id, and nothing is sent", async () => {
    const { worker, clock, published } = setup();
    worker.emitRaw({ ...ask("", KEY), answers: [] });
    await clock.advance(0);
    expect(responses(worker)).toEqual([]);
    expect(notices(published)).toEqual([]);
    expect(worker.stats().droppedRecords).toBe(1);
  });

  it("says so on a rate-limit key of its own, so an extension's noise cannot hide it", async () => {
    const { worker, clock, published } = setup();
    for (let i = 0; i < 64; i++) worker.emit({ ...confirm, id: `d${i}` });
    worker.emit({ ...confirm, id: "x1" }); // an extension's own `limit` cancellation: its notice goes out
    worker.emit(ask("a1", KEY)); // the approval's `limit` cancellation, right after
    await clock.advance(0);
    expect(notices(published)).toEqual([
      "An extension asked a question while too many were waiting. It was cancelled.",
      NOTICE,
    ]);
    expect(codes(published)).toEqual(["dialog_limit", "approval_unshown"]);
  });
});

describe("an id that is already open", () => {
  it("withdraws an open approval for a new approval of the same id, answering its waiter (probe B)", async () => {
    const { live, worker, clock, published } = setup();
    worker.emit(ask("a1", KEY, "bash: echo harmless"));
    worker.emit(ask("a1", "d".repeat(64), "bash: rm -rf /"));
    await clock.advance(0);
    expect(responses(worker)).toEqual([cancelled("a1")]);
    expect(live.dialogs().map((dialog) => dialog.message)).toEqual(["bash: rm -rf /"]);
    expect(published.filter((event) => event.kind === "dialog_closed")).toEqual([
      { kind: "dialog_closed", id: "a1" },
    ]);
    expect(published.filter((event) => event.kind === "dialog_open")).toHaveLength(2);
  });

  it("keeps an open approval and cancels an extension's dialog of the same id (probe A)", async () => {
    const { live, worker, clock, published } = setup();
    worker.emit(ask("a1", KEY));
    worker.emit({ ...confirm, id: "a1" });
    await clock.advance(0);
    expect(responses(worker)).toEqual([{ type: "extension_ui_response", id: "a1", cancelled: true }]);
    expect(live.dialogs().map((dialog) => dialog.method)).toEqual(["approval"]);
    expect(published.filter((event) => event.kind === "dialog_open")).toHaveLength(1);
  });

  it("keeps an open extension dialog and cancels an approval of the same id (probe C)", async () => {
    const { live, worker, clock } = setup();
    worker.emit(confirm);
    worker.emit(ask(confirm.id, KEY));
    await clock.advance(0);
    expect(responses(worker)).toEqual([cancelled(confirm.id)]);
    expect(live.dialogs().map((dialog) => dialog.method)).toEqual(["confirm"]);
  });

  it("still lets an extension's dialog replace an extension's dialog, as in Pi", async () => {
    const { live, worker, clock } = setup();
    worker.emit(confirm);
    worker.emit({ ...confirm, message: "bash: pwd" });
    await clock.advance(0);
    expect(responses(worker)).toEqual([]);
    expect(live.dialogs().map((dialog) => dialog.message)).toEqual(["bash: pwd"]);
  });

  it("closes either kind on extension_ui_closed, sending no response", async () => {
    const { live, worker, clock, published } = setup();
    worker.emit(ask("a1", KEY));
    worker.emit(confirm);
    worker.emit({ type: "extension_ui_closed", id: "a1" });
    worker.emit({ type: "extension_ui_closed", id: confirm.id });
    await clock.advance(0);
    expect(live.dialogs()).toEqual([]);
    expect(responses(worker)).toEqual([]);
    expect(published.filter((event) => event.kind === "dialog_closed")).toEqual([
      { kind: "dialog_closed", id: "a1" },
      { kind: "dialog_closed", id: confirm.id },
    ]);
  });
});

describe("the approval boundary", () => {
  it("cancels an extension's request that names itself an approval (R101)", async () => {
    const { live, worker, clock } = setup();
    worker.emit({ ...confirm, id: "x1", method: "approval" });
    await clock.advance(0);
    expect(responses(worker)).toEqual([{ type: "extension_ui_response", id: "x1", cancelled: true }]);
    expect(live.dialogs()).toEqual([]);
  });

  it("forgets a pending approval when the worker is gone and sends no answer to nobody", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", KEY));
    await clock.advance(0);
    const before = worker.sent.length;
    await worker.stop();
    await clock.advance(0);
    expect(live.dialogs()).toEqual([]);
    expect(() => live.answer("a1", { answer: "once" })).toThrow(new PapError("not_found"));
    expect(responses(worker)).toEqual([]);
    expect(worker.sent.slice(before).map((record) => record.type)).toEqual(["shutdown"]);
  });

  it("keeps a pending approval whole in the snapshot, in the order it came", async () => {
    const { live, worker, clock } = setup();
    worker.emit(confirm);
    worker.emit(ask("a1", KEY, "m".repeat(65_000)));
    await clock.advance(0);
    const snapshot = fitSnapshot({ status: live.status(), rows: [], dialogs: live.dialogs() });
    expect(snapshot.dialogs.map((dialog) => dialog.id)).toEqual(["d1", "a1"]);
    expect(snapshot.dialogs[1]).toMatchObject({
      method: "approval",
      category: "exec",
      answers: ["deny", "once"],
    });
    expect(snapshot.dialogs[1]?.message).toHaveLength(65_000);
  });
});
