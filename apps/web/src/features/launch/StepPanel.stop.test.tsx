// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { launchAt } from "../../testing/launch-bed.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { LaunchPanel } from "./LaunchPanel.tsx";

const NOW = 5_000_000;
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useLaunchStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

const show = async (step: Parameters<typeof launchAt>[0], quiet: number, stoppable = false) => {
  const launch = launchAt(step, NOW - quiet, stoppable ? { stoppable } : {});
  useLaunchStore.getState().apply({ kind: "launch", launch });
  const page = await mount(<LaunchPanel box={launch.box} />);
  await vi.waitFor(() => expect(page.container.querySelector("[data-launch-panel]")).not.toBeNull());
  return { page, launch };
};

describe("Stop on the ask", () => {
  it("the guest ask offers Stop and calls launches.stop", async () => {
    bed.handlers["launches.stop"] = () => ({});
    const { page, launch } = await show("guest", 46_000, true);
    await click(button(page.container, "Stop"));
    expect(bed.called("launches.stop")[0]?.params).toEqual({ id: launch.id });
  });

  it("a launch the daemon does not mark stoppable offers no Stop, whatever the step", async () => {
    const { page } = await show("guest", 46_000);
    expect(page.container.querySelector("[data-launch-ask]")).not.toBeNull();
    expect(page.container.querySelector("[data-launch-ask] button")).toBeNull();
  });

  it("the 75 % image ask says how long the step has run", async () => {
    const { page } = await show("image", 22.5 * 60_000);
    expect(text(page.container.querySelector("[data-launch-ask]") as HTMLElement)).toContain(
      "Project image has been running for",
    );
    expect(text(page.container.querySelector("[data-launch-ask]") as HTMLElement)).toContain(
      "pap gives up at",
    );
  });

  it("the image ask offers no Stop", async () => {
    const { page } = await show("image", 130_000);
    const buttons = [...page.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Show the log"]);
  });

  it("checks and disk offer no action", async () => {
    for (const step of ["checks", "disk"] as const) {
      useLaunchStore.getState().reset();
      const { page } = await show(step, 400_000);
      expect(page.container.querySelector("[data-launch-ask]")?.querySelector("button") ?? null).toBeNull();
    }
  });

  it("a failed stop shows an InlineError under the ask", async () => {
    bed.handlers["launches.stop"] = () => {
      throw new RpcError("not_found");
    };
    const { page } = await show("vm", 46_000, true);
    await click(button(page.container, "Stop"));
    await settle();
    expect(page.container.querySelector('[data-slot="inline-error"][role="alert"]')).not.toBeNull();
  });

  it("a launch stopped by its owner leaves no error", async () => {
    bed.handlers["launches.stop"] = () => ({});
    const { page, launch } = await show("vm", 46_000, true);
    await click(button(page.container, "Stop"));
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "end", id: launch.id, done: true, ok: false, code: "stopped" });
    });
    await settle();
    expect(page.container.querySelector("[data-launch-panel]")).toBeNull();
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(text(page.container)).toBe("");
  });
});
