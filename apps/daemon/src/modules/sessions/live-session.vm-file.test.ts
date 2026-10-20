import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { startLiveSession } from "./live-session.ts";
import { INIT, READY } from "./testing/live-bed.ts";

/*
 * Mutant (RT-43), run for real: `piFile` answers the ready record's path again for a VM worker -> "a VM session's file is
 * its mirror" fails (J1: the row would bind a path inside the VM, a reopen would start a new session instead of resuming).
 */
function setup(vmFile?: () => string | null) {
  const clock = createFakeClock();
  const base = createFakeWorker({ clock, reply: () => ({}) });
  const worker = vmFile ? Object.assign(base, { piFile: vmFile }) : base;
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
  worker.emit({ ...READY, sessionFile: "/agent/.pi/sessions/in-the-vm.jsonl" });
  return live;
}

describe("a live session's Pi file", () => {
  it("is the path the worker reported, for a host worker", () => {
    expect(setup().piFile()).toBe("/agent/.pi/sessions/in-the-vm.jsonl");
  });

  it("is the mirror for a VM worker, and nothing while the mirror is not open (M-vm-path)", () => {
    let mirror: string | null = null;
    const live = setup(() => mirror);
    expect(live.piFile()).toBeUndefined();
    mirror = "/pap/agents/.mirrors/scout-0001/s.jsonl";
    expect(live.piFile()).toBe("/pap/agents/.mirrors/scout-0001/s.jsonl");
  });
});
