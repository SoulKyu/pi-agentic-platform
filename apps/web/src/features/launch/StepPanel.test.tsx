// @vitest-environment happy-dom
import { InlineError } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { mount, settle, statuses, text } from "../../testing/dom.ts";
import { launchAt, PROJECT_BOX, stepOf } from "../../testing/launch-bed.ts";
import { LaunchPanel } from "./LaunchPanel.tsx";
import StepPanel from "./StepPanel.tsx";

const NOW = 5_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  useLaunchStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("StepPanel", () => {
  it("done steps show their time, a skipped image says already built, the active step counts once a second", async () => {
    const launch = launchAt("vm", NOW - 5000, {}, { usualMs: 4000 });
    const checks = stepOf("checks", { state: "done", startedAt: NOW - 20_000, endedAt: NOW - 18_000 });
    const image = stepOf("image", { state: "skipped" });
    const disk = stepOf("disk", { state: "done", startedAt: NOW - 18_000, endedAt: NOW - 5000 });
    launch.steps.splice(0, 3, checks, image, disk);
    const page = await mount(<StepPanel launch={launch} />);
    const rows = [...page.container.querySelectorAll("li")].map((row) => text(row));
    expect(rows[0]).toBe("Checks2 s");
    expect(rows[1]).toBe("Project imagealready built");
    expect(rows[2]).toBe("Disk13 s");
    expect(rows[3]).toBe("VM start5 s · usually 4 s");
    await tick(1000);
    expect([...page.container.querySelectorAll("li")][3]?.textContent).toBe("VM start6 s · usually 4 s");
    await tick(3000);
    expect([...page.container.querySelectorAll("li")][3]?.textContent).toBe("VM start9 s · usually 4 s");
  });

  it("says slower than usual past twice the median, in neutral text and without an alert", async () => {
    const launch = launchAt("vm", NOW - 9000, {}, { usualMs: 4000 });
    const page = await mount(<StepPanel launch={launch} />);
    const slow = [...page.container.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Slower"));
    expect(slow?.textContent).toBe("Slower than usual. pap gives up at 1 min.");
    expect(slow?.className).toContain("text-muted");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(page.container.innerHTML).not.toContain("text-err");
  });

  it("the ask is a status block with Stop at 75 % of the guest limit, and no Show the log outside an image", async () => {
    const launch = launchAt("guest", NOW - 46_000, { stoppable: true });
    const page = await mount(<StepPanel launch={launch} />);
    expect(statuses(page.container)).toContain(
      "Guest ready has been running for 46 s. pap gives up at 1 min.Stop",
    );
    const buttons = [...page.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Stop"]);
  });

  it("an image step shows its last line and its ask offers Show the log alone", async () => {
    const launch = launchAt(
      "image",
      NOW - 200_000,
      {},
      { detail: { line: "#7 RUN apt-get install", at: NOW - 130_000 } },
    );
    const page = await mount(<StepPanel launch={launch} />);
    expect(text(page.container)).toContain("#7 RUN apt-get install · 2 min 10 s ago");
    expect(text(page.container)).toContain("Building the image");
    expect([...page.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Show the log",
    ]);
  });

  it("a failed step leaves its InlineError when the launch ends", async () => {
    const failed = launchAt("guest", NOW - 10_000);
    failed.steps[4] = stepOf("guest", {
      state: "failed",
      startedAt: NOW - 10_000,
      endedAt: NOW,
      code: "capacity",
    });
    useLaunchStore.getState().apply({ kind: "launch", launch: failed });
    const page = await mount(
      <>
        <LaunchPanel box={failed.box} />
        <InlineError announce="action">pap could not start the box.</InlineError>
      </>,
    );
    await settle();
    expect(page.container.querySelector("[data-launch-panel]")).not.toBeNull();
    expect(page.container.querySelector('[data-step="guest"]')?.getAttribute("data-state")).toBe("failed");
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "end", id: "l1", done: true, ok: false, code: "capacity" });
    });
    expect(page.container.querySelector("[data-launch-panel]")).toBeNull();
    expect(text(page.container)).toBe("pap could not start the box.");
    expect(PROJECT_BOX).toBe(failed.box.id);
  });
});
