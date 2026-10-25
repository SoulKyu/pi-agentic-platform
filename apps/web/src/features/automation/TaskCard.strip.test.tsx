// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { current, newBed, NOW, showWithStepUp, taskOf } from "./board-bed.tsx";
import { TaskCard } from "./TaskCard.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => useLaunchStore.getState().reset());

const strips = async (patch: Parameters<typeof taskOf>[0], launchFor: string) => {
  newBed();
  useLaunchStore.getState().apply({
    kind: "launch",
    launch: { ...launchAt("vm", Date.now() - 1000), for: launchFor },
  });
  const page = await showWithStepUp(
    <ul>
      <TaskCard
        task={taskOf({ projectId: PROJECT_BOX, ...patch })}
        now={NOW}
        current={false}
        onOpenSession={() => {}}
      />
    </ul>,
  );
  await act(async () => {});
  return page.container.querySelectorAll("[data-launch-strip]").length;
};

describe("TaskCard launch strip", () => {
  it("a finished task's card shows no launch strip while its box starts for another task", async () => {
    expect(await strips({ id: "t1", state: "done" }, "t2")).toBe(0);
    expect(await strips({ id: "t1", state: "running" }, "t2")).toBe(0);
  });

  it("shows the strip on the task the launch is for, and on a queued task", async () => {
    expect(await strips({ id: "t1", state: "running" }, "t1")).toBe(1);
    expect(await strips({ id: "t1", state: "queued" }, "t2")).toBe(1);
  });
});
