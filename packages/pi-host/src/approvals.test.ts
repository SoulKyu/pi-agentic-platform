import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { type ApprovalAsk, createApprovals, MAX_PENDING_APPROVALS } from "./approvals.ts";

const KEY = "b".repeat(64);
const request: ApprovalAsk = {
  category: "exec",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  tool: "bash",
  key: KEY,
  answers: ["deny", "once"],
};
const CLOSED = { answer: "deny", closed: true };

const sequence = () => {
  let count = 0;
  return () => `a${count++}`;
};

describe("approvals", () => {
  it("asks with its own record and returns the answer", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals(
      (record) => {
        sent.push(record);
        return true;
      },
      { newId: () => "a1" },
    );
    const answer = approvals.ask(request);
    expect(sent).toEqual([{ type: "approval_request", id: "a1", ...request, answers: ["deny", "once"] }]);
    approvals.resolve({ id: "a1", answer: "once" });
    expect(await answer).toEqual({ answer: "once", closed: false });
  });

  it("treats an answer it did not offer as a refusal", async () => {
    const approvals = createApprovals(() => true, { newId: () => "a1" });
    const answer = approvals.ask(request);
    approvals.resolve({ id: "a1", answer: "always" });
    expect(await answer).toEqual({ answer: "deny", closed: false });
  });

  it("ignores an unknown id and a second response for an id", async () => {
    const approvals = createApprovals(() => true, { newId: () => "a1" });
    const answer = approvals.ask(request);
    approvals.resolve({ id: "nope", answer: "once" });
    expect(approvals.pendingCount()).toBe(1);
    approvals.resolve({ id: "a1", answer: "deny" });
    approvals.resolve({ id: "a1", answer: "once" });
    expect(await answer).toEqual({ answer: "deny", closed: false });
    expect(approvals.pendingCount()).toBe(0);
  });

  it("closes on abort, on cancelAll and when the request cannot be sent, always as a refusal", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals(
      (record) => {
        sent.push(record);
        return true;
      },
      { newId: () => `a${sent.length}` },
    );
    const controller = new AbortController();
    const aborted = approvals.ask(request, controller.signal);
    controller.abort();
    expect(await aborted).toEqual(CLOSED);
    expect(sent.at(-1)).toEqual({ type: "extension_ui_closed", id: "a0" });
    const pending = approvals.ask(request);
    approvals.cancelAll();
    expect(await pending).toEqual(CLOSED);
    const unsent = createApprovals(() => false, { newId: () => "x" });
    expect(await unsent.ask(request)).toEqual(CLOSED);
    expect(approvals.pendingCount() + unsent.pendingCount()).toBe(0);
  });

  it("closes a question whose send throws, and one asked with a signal already aborted, sending nothing", async () => {
    const throwing = createApprovals(
      () => {
        throw new Error("channel gone");
      },
      { newId: () => "x" },
    );
    expect(await throwing.ask(request)).toEqual(CLOSED);
    expect(throwing.pendingCount()).toBe(0);
    const sent: unknown[] = [];
    const approvals = createApprovals((record) => sent.push(record) > 0, { newId: () => "a1" });
    const controller = new AbortController();
    controller.abort();
    expect(await approvals.ask(request, controller.signal)).toEqual(CLOSED);
    expect(sent).toEqual([]);
  });

  it("closes at once a question the daemon would refuse, and never sends it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals(
      (record) => {
        sent.push(record);
        return true;
      },
      { newId: () => "a1" },
    );
    const refused: ApprovalAsk[] = [
      { ...request, title: "t".repeat(4097) },
      { ...request, message: "m".repeat(65_537) },
      { ...request, tool: "" },
      { ...request, key: "short" },
      { ...request, answers: [] },
    ];
    for (const bad of refused) expect(await approvals.ask(bad)).toEqual(CLOSED);
    expect(await createApprovals(() => true, { newId: () => "" }).ask(request)).toEqual(CLOSED);
    expect(sent).toEqual([]);
    expect(approvals.pendingCount()).toBe(0);
  });

  it("treats a question the daemon answered cancelled as closed, never as a refusal (M2-RT-22)", async () => {
    const approvals = createApprovals(() => true, { newId: () => "a1" });
    const answer = approvals.ask(request);
    approvals.resolve({ id: "a1", answer: "deny", cancelled: true });
    expect(await answer).toEqual(CLOSED);
  });

  it("holds at most MAX_PENDING_APPROVALS questions and closes the next one without sending it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals(
      (record) => {
        sent.push(record);
        return true;
      },
      { newId: sequence() },
    );
    const open = Array.from({ length: MAX_PENDING_APPROVALS }, () => approvals.ask(request));
    expect(approvals.pendingCount()).toBe(MAX_PENDING_APPROVALS);
    expect(await approvals.ask(request)).toEqual(CLOSED);
    expect(sent).toHaveLength(MAX_PENDING_APPROVALS);
    expect(approvals.pendingCount()).toBe(MAX_PENDING_APPROVALS);
    approvals.resolve({ id: "a0", answer: "once" });
    expect(await open[0]).toEqual({ answer: "once", closed: false });
    const again = approvals.ask(request);
    expect(approvals.pendingCount()).toBe(MAX_PENDING_APPROVALS);
    approvals.cancelAll();
    expect(await Promise.all([...open.slice(1), again])).toEqual(Array(MAX_PENDING_APPROVALS).fill(CLOSED));
    expect(approvals.pendingCount()).toBe(0);
  });

  it("closes a question whose generated id is already open, and keeps the open one", async () => {
    const approvals = createApprovals(() => true, { newId: () => "same" });
    const first = approvals.ask(request);
    expect(await approvals.ask(request)).toEqual(CLOSED);
    approvals.resolve({ id: "same", answer: "once" });
    expect(await first).toEqual({ answer: "once", closed: false });
  });

  it("removes its abort listener on every way a question ends", async () => {
    const paths: Array<[string, (approvals: ReturnType<typeof createApprovals>, id: string) => void]> = [
      ["answered", (approvals, id) => approvals.resolve({ id, answer: "once" })],
      ["cancelled", (approvals, id) => approvals.resolve({ id, answer: "deny", cancelled: true })],
      ["cancelAll", (approvals) => approvals.cancelAll()],
    ];
    for (const [, end] of paths) {
      const approvals = createApprovals(() => true, { newId: () => "a1" });
      const controller = new AbortController();
      const answer = approvals.ask(request, controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      end(approvals, "a1");
      await answer;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
    const invalid = createApprovals(() => true, { newId: () => "a1" });
    const refused = new AbortController();
    await invalid.ask({ ...request, tool: "" }, refused.signal);
    expect(getEventListeners(refused.signal, "abort")).toHaveLength(0);
    const unsent = createApprovals(() => false, { newId: () => "a1" });
    const controller = new AbortController();
    await unsent.ask(request, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const full = createApprovals(() => true, { newId: sequence() });
    for (let i = 0; i < MAX_PENDING_APPROVALS; i++) void full.ask(request);
    const late = new AbortController();
    await full.ask(request, late.signal);
    expect(getEventListeners(late.signal, "abort")).toHaveLength(0);
    full.cancelAll();
  });
});
