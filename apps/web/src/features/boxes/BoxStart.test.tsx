// @vitest-environment happy-dom
import { act, Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { mount, settle } from "../../testing/dom.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { BoxStart } from "./BoxStart.tsx";

beforeEach(() => useLaunchStore.getState().reset());

describe("BoxStart", () => {
  it("the button says Building the image… while the image step runs", async () => {
    const page = await mount(<BoxStart box={{ kind: "project", id: PROJECT_BOX }} phase="starting" />);
    await settle();
    const button = page.container.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Start");
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("image", Date.now() - 2000) });
    });
    await vi.waitFor(() => expect(button.textContent).toBe("Building the image…"));
    expect(button.disabled).toBe(true);
    expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("disk", Date.now() - 1000) });
    });
    await vi.waitFor(() => expect(button.textContent).toBe("Preparing the disk…"));
  });

  it("a launch record that changes while the step does not leaves the button alone", async () => {
    let renders = 0;
    const page = await mount(
      <Profiler id="start" onRender={() => void (renders += 1)}>
        <BoxStart box={{ kind: "project", id: PROJECT_BOX }} phase="starting" />
      </Profiler>,
    );
    const at = Date.now();
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("image", at - 2000) });
    });
    await vi.waitFor(() =>
      expect(page.container.querySelector("button")?.textContent).toBe("Building the image…"),
    );
    const settled = renders;
    for (const line of ["a", "b", "c"])
      await act(async () => {
        useLaunchStore.getState().apply({
          kind: "launch",
          launch: launchAt("image", at - 2000, {}, { detail: { line, at } }),
        });
      });
    expect(renders).toBe(settled);
  });

  it("an agent's start waits in the agent's words, not the box's", async () => {
    vi.useFakeTimers();
    try {
      const page = await mount(<BoxStart box={{ kind: "agent", id: "atlas-1a2b" }} phase="starting" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      const status = page.container.querySelector('[role="status"]');
      expect(status?.textContent).toBe("Starting the agent's VM…");
      expect(page.container.textContent).not.toContain("box");
    } finally {
      vi.useRealTimers();
    }
  });
});
