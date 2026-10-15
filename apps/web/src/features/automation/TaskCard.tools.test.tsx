// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { current, newBed, NOW, prompt, showWithStepUp, taskOf } from "./board-bed.tsx";
import { TaskCard } from "./TaskCard.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  prompt.answer = true;
  prompt.asked = 0;
});

const card = (patch = {}) =>
  showWithStepUp(
    <ul>
      <TaskCard
        task={taskOf({ state: "done", ...patch })}
        now={NOW}
        current={false}
        onOpenSession={() => {}}
      />
    </ul>,
  );

describe("Use my normal tools", () => {
  it("explains first, and sends nothing until the person confirms", async () => {
    const bed = newBed();
    const page = await card();
    await click(button(page.container, "Use my normal tools"));
    expect(document.body.textContent).toContain(
      "The session keeps its history and taint; its next run uses your usual tools and approval mode.",
    );
    expect(bed.called("automation.tasks.releaseTools")).toHaveLength(0);
    await click(button(document.body, "Not now"));
    expect(bed.called("automation.tasks.releaseTools")).toHaveLength(0);
  });

  it("sends releaseTools by task with a commandId once confirmed", async () => {
    const bed = newBed();
    const page = await card();
    await click(button(page.container, "Use my normal tools"));
    await click(button(document.body, "Confirm"));
    await settle();
    const [call] = bed.called("automation.tasks.releaseTools");
    expect(call?.params).toEqual({ taskId: "t1" });
    expect(call?.options?.commandId).toBeTruthy();
    expect(prompt.asked).toBe(0);
  });

  it("goes through the password step-up when the daemon asks, then sends it again", async () => {
    const bed = newBed();
    let asked = 0;
    bed.handlers["automation.tasks.releaseTools"] = () => {
      asked += 1;
      if (asked === 1) throw new RpcError("step_up_required");
      return { taskId: "t1", sessionId: "s1" };
    };
    const page = await card();
    await click(button(page.container, "Use my normal tools"));
    await click(button(document.body, "Confirm"));
    await settle();
    expect(prompt.asked).toBe(1);
    expect(bed.called("automation.tasks.releaseTools")).toHaveLength(2);
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does nothing more when the person cancels the password prompt", async () => {
    const bed = newBed();
    prompt.answer = false;
    bed.handlers["automation.tasks.releaseTools"] = () => {
      throw new RpcError("step_up_required");
    };
    const page = await card();
    await click(button(page.container, "Use my normal tools"));
    await click(button(document.body, "Confirm"));
    await settle();
    expect(bed.called("automation.tasks.releaseTools")).toHaveLength(1);
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("falls back to the session when the task row is gone but the session kept its list", async () => {
    const bed = newBed();
    bed.handlers["automation.tasks.releaseTools"] = (params) => {
      if ("taskId" in (params as object)) throw new RpcError("not_found");
      return { taskId: null, sessionId: "s1" };
    };
    const page = await card();
    await click(button(page.container, "Use my normal tools"));
    await click(button(document.body, "Confirm"));
    await settle();
    expect(bed.called("automation.tasks.releaseTools").map((call) => call.params)).toEqual([
      { taskId: "t1" },
      { sessionId: "s1" },
    ]);
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("says the session is busy in plain words", async () => {
    const bed = newBed();
    bed.handlers["automation.tasks.releaseTools"] = () => {
      throw new RpcError("session_busy");
    };
    const page = await card();
    await click(button(page.container, "Use my normal tools"));
    await click(button(document.body, "Confirm"));
    await settle();
    expect(text(page.container.querySelector('[role="alert"]') as HTMLElement)).toContain("working");
  });

  it("is not offered once the list is lifted", async () => {
    newBed();
    const page = await card({ toolsReleased: true });
    expect(hasButton(page.container, "Use my normal tools")).toBe(false);
  });
});
