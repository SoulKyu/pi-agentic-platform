// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { NOW, box, ownerSnapshot } from "./overview-fixtures.ts";
import { callbacks, showIn } from "./overview-bed.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});

describe("the task line", () => {
  it("a stoppable task line has STOP, which cancels that task; a session and an unstoppable task have none", async () => {
    const root = await showIn(
      bed,
      ownerSnapshot({
        boxes: [
          box({
            activities: [
              { kind: "session", id: "s2", title: "Fix", since: null, stoppable: false },
              { kind: "task", id: "t1", title: "Tidy", since: null, stoppable: true },
              { kind: "task", id: "t2", title: "Held", since: null, stoppable: false },
            ],
          }),
        ],
      }),
      callbacks(),
    );
    expect(root.querySelectorAll("[data-task-stop]")).toHaveLength(1);
    expect(hasButton(root, "Stop")).toBe(true);
    await click(button(root, "Stop"));
    await settle();
    expect(bed.called("automation.tasks.cancel")[0]?.params).toEqual({ taskId: "t1" });
  });
});
