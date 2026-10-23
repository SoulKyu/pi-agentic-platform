import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createVmWorker, EXIT_TAIL_GRACE_MS, type Wire } from "./vm-worker.ts";

const wire: Wire = { send: () => true, close: () => {}, pause: () => {}, resume: () => {} };

function make() {
  const clock = createFakeClock();
  const worker = createVmWorker({
    clock,
    logger: captureLogger().logger,
    label: {},
    slot: "s",
    input: {
      sessionFile: null,
      sessionsDir: "/agent/.pi/sessions",
      mirrorFor: () => "refused",
      unsent: () => false,
      sent: () => {},
    },
    wire,
    mirror: null,
    reported: { file: null, size: 0, lastEntryId: null },
    signal: () => {},
  });
  return { clock, worker };
}

describe("a VM worker's last words", () => {
  it("keeps the tail of an exited frame that arrives after the wire closed", async () => {
    const { clock, worker } = make();
    worker.wireClosed();
    await clock.advance(100);
    worker.guestExited({ code: 70, signal: null, cause: "exit_code" }, "pi-host: bad field policy.rules[0]");
    expect(await worker.handle.exited).toMatchObject({ code: 70 });
    expect(worker.handle.outputTail()).toBe("pi-host: bad field policy.rules[0]");
  });

  it("exits with an empty tail when no frame comes within the grace", async () => {
    const { clock, worker } = make();
    worker.wireClosed();
    await clock.advance(EXIT_TAIL_GRACE_MS - 1);
    let done = false;
    void worker.handle.exited.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await clock.advance(1);
    expect((await worker.handle.exited).cause).toBe("exit_code");
    expect(worker.handle.outputTail()).toBe("");
  });

  it("exits at once when the guest link is gone", async () => {
    const { worker } = make();
    worker.guestGone();
    worker.wireClosed();
    expect((await worker.handle.exited).cause).toBe("exit_code");
  });

  it("exits at once when the guest link goes during the grace", async () => {
    const { worker } = make();
    worker.wireClosed();
    worker.guestGone();
    expect((await worker.handle.exited).cause).toBe("exit_code");
  });
});
