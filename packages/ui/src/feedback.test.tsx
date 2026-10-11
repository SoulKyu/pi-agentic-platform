// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackPhase, usePendingAction, usePendingFeedback } from "./feedback.ts";
import { mount } from "./testing/dom.ts";

describe("feedback timing (DESIGN.md §7.3, Orca STYLEGUIDE UX rule 1)", () => {
  it.each([
    [null, false, "idle"],
    [50, false, "quiet"],
    [100, false, "disabled"],
    [999, false, "disabled"],
    [1000, false, "spinner"],
    [2999, false, "spinner"],
    [3000, false, "stage"],
    [0, true, "disabled"],
    [199, true, "disabled"],
    [200, true, "spinner"],
    [3000, true, "stage"],
  ] as const)("%s ms (remote %s) → %s", (elapsed, remote, phase) => {
    expect(feedbackPhase(elapsed, remote)).toBe(phase);
  });
});

describe("usePendingFeedback", () => {
  let now = 0;
  const clock = { now: () => now };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Probe({ since, remote }: { since: number | null; remote: boolean }) {
    return <p>{usePendingFeedback(since, { remote, clock })}</p>;
  }

  it("walks a remote action through disabled, spinner and stage, and back to idle", async () => {
    now = 1000;
    const page = await mount(<Probe since={1000} remote />);
    expect(page.container.textContent).toBe("disabled");
    await act(async () => {
      now = 1200;
      vi.advanceTimersByTime(200);
    });
    expect(page.container.textContent).toBe("spinner");
    await act(async () => {
      now = 4000;
      vi.advanceTimersByTime(2800);
    });
    expect(page.container.textContent).toBe("stage");
    await page.rerender(<Probe since={null} remote />);
    expect(page.container.textContent).toBe("idle");
    await page.unmount();
  });

  it("keeps a local action quiet for its first 100 ms", async () => {
    now = 0;
    const page = await mount(<Probe since={0} remote={false} />);
    expect(page.container.textContent).toBe("quiet");
    await act(async () => {
      now = 100;
      vi.advanceTimersByTime(100);
    });
    expect(page.container.textContent).toBe("disabled");
    await page.unmount();
  });
});

describe("usePendingAction", () => {
  it("runs one action at a time and ignores a second call while it is in flight", async () => {
    let run: ReturnType<typeof usePendingAction>["run"] | undefined;
    function Probe() {
      const pending = usePendingAction({ now: () => 5 });
      run = pending.run;
      return <p>{pending.since === null ? "idle" : "pending"}</p>;
    }
    const page = await mount(<Probe />);
    let release: () => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        }),
    );
    let first: Promise<string | undefined> | undefined;
    let second: Promise<string | undefined> | undefined;
    await act(async () => {
      first = run?.(action);
      second = run?.(action);
    });
    expect(page.container.textContent).toBe("pending");
    expect(action).toHaveBeenCalledTimes(1);
    expect(await second).toBeUndefined();
    let result: string | undefined;
    await act(async () => {
      release();
      result = await first;
    });
    expect(result).toBe("done");
    expect(page.container.textContent).toBe("idle");
    await page.unmount();
  });
});
