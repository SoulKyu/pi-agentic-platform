import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOomScore, startParentWatchdog } from "./watchdog.ts";

afterEach(() => vi.useRealTimers());

describe("watchdog", () => {
  it("calls onOrphan once the parent pid changes", () => {
    vi.useFakeTimers();
    let ppid = 10;
    const onOrphan = vi.fn();
    const stop = startParentWatchdog({
      initialPpid: 10,
      currentPpid: () => ppid,
      intervalMs: 1000,
      onOrphan,
    });
    vi.advanceTimersByTime(1000);
    expect(onOrphan).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(onOrphan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onOrphan).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops checking once stopped", () => {
    vi.useFakeTimers();
    let ppid = 10;
    const onOrphan = vi.fn();
    const stop = startParentWatchdog({
      initialPpid: 10,
      currentPpid: () => ppid,
      intervalMs: 1000,
      onOrphan,
    });
    stop();
    ppid = 1;
    vi.advanceTimersByTime(5000);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it("writes 800 to oom_score_adj on Linux only", () => {
    const writes: Array<[string, string]> = [];
    expect(
      applyOomScore(800, {
        platform: "linux",
        write: (path, value) => {
          writes.push([path, value]);
        },
      }),
    ).toBe(true);
    expect(writes).toEqual([["/proc/self/oom_score_adj", "800"]]);
    expect(applyOomScore(800, { platform: "darwin", write: () => {} })).toBe(false);
    expect(
      applyOomScore(800, {
        platform: "linux",
        write: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe(false);
  });
});
