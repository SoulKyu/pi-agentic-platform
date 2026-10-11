import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fitSnapshot } from "./snapshot.ts";
import { startLiveSession } from "./live-session.ts";
import { confirm, createLiveBed } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

const ask = (id: string, key: string, message = "bash: ls", fields: Record<string, unknown> = {}) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message,
  answers: ["deny", "once"] as Array<"deny" | "once">,
  tool: "bash",
  key,
  ...fields,
});
const responses = (worker: ReturnType<typeof setup>["worker"]) =>
  worker.sent.filter((record) => record.type === "approval_response");

describe("approvals of the live session", () => {
  it("answers an approval with the policy's record, mapping the M1 answers", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", "c".repeat(64)));
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
    worker.emit(ask("a1", "c".repeat(64)));
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
    worker.emit(ask("a1", "c".repeat(64), "bash: ls"));
    await clock.advance(0);
    expect(live.answer("a1", { answer: "once" })).toEqual({
      answer: "once",
      grant: { tool: "bash", key: "c".repeat(64), label: "bash: ls" },
    });
    expect(() => live.answer("a1", { answer: "once" })).toThrow(new PapError("not_found"));
  });

  it("maps a refusal to deny and a closed card to a cancelled deny, not to the user's refusal", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", "c".repeat(64)));
    worker.emit(ask("a2", "d".repeat(64)));
    await clock.advance(0);
    expect(live.answer("a1", { confirmed: false })?.answer).toBe("deny");
    expect(live.answer("a2", { cancelled: true })).toBeNull();
    expect(responses(worker)).toEqual([
      { type: "approval_response", id: "a1", answer: "deny" },
      { type: "approval_response", id: "a2", answer: "deny", cancelled: true },
    ]);
  });

  it("answers an approval it cannot show as cancelled, never as the user's refusal (M2-RT-22)", async () => {
    const { worker, clock, published } = setup();
    // 64 open dialogs is the registry's limit (spec C §2.4): the 65th question, an approval, cannot be shown.
    for (let i = 0; i < 64; i++) worker.emit({ ...confirm, id: `d${i}` });
    worker.emit(ask("a1", "c".repeat(64)));
    await clock.advance(0);
    expect(responses(worker)).toEqual([
      { type: "approval_response", id: "a1", answer: "deny", cancelled: true },
    ]);
    expect(published.filter((event) => event.kind === "dialog_open" && event.dialog.id === "a1")).toEqual([]);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(1);
  });

  it("answers a malformed approval (no answers, no category, too long) as cancelled", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", "c".repeat(64), "bash: ls", { answers: [] }));
    worker.emit(ask("a2", "c".repeat(64), "bash: ls", { category: undefined }));
    worker.emit(ask("a3", "c".repeat(64), "x".repeat(65_537)));
    await clock.advance(0);
    expect(responses(worker)).toEqual(
      ["a1", "a2", "a3"].map((id) => ({ type: "approval_response", id, answer: "deny", cancelled: true })),
    );
    expect(live.dialogs()).toEqual([]);
  });

  it("refuses an approval answer for an extension's confirm", async () => {
    const { live, worker, clock } = setup();
    worker.emit(confirm);
    await clock.advance(0);
    expect(() => live.answer(confirm.id, { answer: "once" })).toThrow(new PapError("bad_request"));
    expect(live.dialogs()).toHaveLength(1);
    live.answer(confirm.id, { confirmed: true });
    expect(worker.sent.filter((record) => record.type === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: confirm.id, confirmed: true },
    ]);
  });

  it("forgets a pending approval when the worker is gone, so no answer is sent to nobody", async () => {
    const { live, worker, clock } = setup();
    worker.emit(ask("a1", "c".repeat(64)));
    await clock.advance(0);
    await worker.stop();
    await clock.advance(0);
    expect(() => live.answer("a1", { answer: "once" })).toThrow(new PapError("not_found"));
  });

  it("keeps pending approvals in the snapshot, ahead of extension dialogs, whole", async () => {
    const { live, worker, clock } = setup();
    worker.emit(confirm);
    worker.emit(ask("a1", "c".repeat(64), "m".repeat(65_000)));
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
