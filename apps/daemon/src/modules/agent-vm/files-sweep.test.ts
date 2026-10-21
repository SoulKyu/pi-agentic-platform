import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { startFilesTrashSweep } from "./files-sweep.ts";
import { TRASH_KEEP_MS } from "./trash.ts";

const DAY = 86_400_000;

describe("the files trash sweep, whatever the runtime", () => {
  it("sweeps at start and once a day with the 7 days, and stops", async () => {
    const clock = createFakeClock();
    const files = { sweepTrash: vi.fn() };
    const stop = startFilesTrashSweep({ files, clock, logger: { warn: vi.fn() } });
    expect(files.sweepTrash).toHaveBeenCalledWith(clock.now(), TRASH_KEEP_MS);
    await clock.advance(DAY);
    expect(files.sweepTrash).toHaveBeenCalledTimes(2);
    stop();
    await clock.advance(3 * DAY);
    expect(files.sweepTrash).toHaveBeenCalledTimes(2);
  });

  it("logs a sweep that throws and keeps the schedule", async () => {
    const clock = createFakeClock();
    const warn = vi.fn();
    const files = {
      sweepTrash: vi.fn(() => {
        throw new Error("EIO");
      }),
    };
    startFilesTrashSweep({ files, clock, logger: { warn } });
    await clock.advance(DAY);
    expect(files.sweepTrash).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("agent_files_trash_sweep_failed", expect.anything());
  });
});
