import { type InitRecord, PapError, type SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { startLiveSession } from "./live-session.ts";
import { INIT, READY } from "./testing/live-bed.ts";

/*
 * Mutants (RT-43), run for real:
 * - `vm` read from the worker's record instead of the daemon's own init -> "a worker cannot make its card a VM card
 *   or a host card" fails.
 * - the registry leaves `vm` off the dialog -> "marks the card of a VM session" fails.
 * - `approvalAnswerOf` stops refusing "always" for a VM card -> "refuses an Always answer" fails.
 */
const VM_INIT = { ...INIT, vm: { slot: "s1" } } as unknown as InitRecord;
const ask = (fields: Record<string, unknown> = {}) => ({
  type: "approval_request" as const,
  id: "a1",
  category: "exec" as const,
  title: "Run?",
  message: "bash: ls",
  answers: ["deny", "session", "always", "once"] as Array<"deny" | "session" | "always" | "once">,
  tool: "bash",
  key: "c".repeat(64),
  tainted: false,
  ...fields,
});

function setup(init: InitRecord) {
  const clock = createFakeClock();
  const worker = createFakeWorker({ clock, reply: () => ({}) });
  const published: SessionStreamEvent[] = [];
  const live = startLiveSession(
    {
      handle: worker,
      clock,
      logger: silentLogger,
      publish: (event) => published.push(event),
      record: () => {},
      onActivity: () => {},
      onExit: () => {},
      onName: () => {},
      idleMs: 0,
    },
    init,
  );
  worker.emit(READY);
  return { live, worker, published };
}

describe("the approval card of a VM session (AVM-E33, AVM-E18)", () => {
  it("marks the card of a VM session, from the daemon's own init", () => {
    const { live, worker } = setup(VM_INIT);
    worker.emit(ask());
    expect(live.dialogs().map((dialog) => dialog.vm)).toEqual([true]);
  });

  it("leaves a host session's card without the mark", () => {
    const { live, worker } = setup(INIT);
    worker.emit(ask());
    const [dialog] = live.dialogs();
    expect(dialog).toBeDefined();
    expect(dialog).not.toHaveProperty("vm");
  });

  it("a worker cannot make its card a VM card or a host card", () => {
    const vm = setup(VM_INIT);
    vm.worker.emit(ask({ vm: false }));
    expect(vm.live.dialogs().map((dialog) => dialog.vm)).toEqual([true]);
    const host = setup(INIT);
    host.worker.emit(ask({ vm: true }));
    expect(host.live.dialogs()[0]).not.toHaveProperty("vm");
  });

  it("refuses an Always answer for a VM card and keeps it open (no host rule to write)", () => {
    const { live, worker } = setup(VM_INIT);
    worker.emit(ask());
    expect(() => live.answer("a1", { answer: "always" })).toThrow(new PapError("bad_request"));
    expect(live.dialogs().map((dialog) => dialog.id)).toEqual(["a1"]);
    expect(live.answer("a1", { answer: "session" })?.answer).toBe("session");
  });
});
