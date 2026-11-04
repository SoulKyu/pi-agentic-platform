// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { alerts, button, click, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { TaskStop } from "./TaskStop.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});

describe("TaskStop", () => {
  it("cancels the task at once, with a command id and no dialog", async () => {
    const page = await mount(<TaskStop taskId="t1" />);
    await click(button(page.container, "Stop"));
    await settle();
    const [call] = bed.called("automation.tasks.cancel");
    expect(call?.params).toEqual({ taskId: "t1" });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a refused cancel is announced as an action error", async () => {
    bed.handlers["automation.tasks.cancel"] = () => {
      throw new RpcError("conflict");
    };
    const page = await mount(<TaskStop taskId="t1" />);
    await click(button(page.container, "Stop"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
  });
});
