// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { current, newBed, NOW, showWithStepUp, taskOf } from "./board-bed.tsx";
import { TaskCard } from "./TaskCard.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => setLocale("en"));

const card = (
  patch = {},
  opened: (sessionId: string, taskId: string) => void = () => {},
  isCurrent = false,
) =>
  showWithStepUp(
    <ul>
      <TaskCard task={taskOf(patch)} now={NOW} current={isCurrent} onOpenSession={opened} />
    </ul>,
  );

describe("TaskCard", () => {
  it("fences the detail in the dashed UNTRUSTED frame and renders it as text", async () => {
    newBed();
    const page = await card({ detail: "<img src=x onerror=alert(1)> FIRING" });
    const fence = page.container.querySelector('[data-slot="fence"]') as HTMLElement;
    expect(fence.querySelector("figcaption")?.textContent).toBe("UNTRUSTED · webhook");
    expect(fence.textContent).toContain("<img src=x onerror=alert(1)> FIRING");
    expect(page.container.querySelector("img")).toBeNull();
  });

  it("shows the detail it is given as one text node, with no bidi character", async () => {
    newBed();
    const page = await card({ detail: "FIRING api-7f9c" });
    const body = page.container.querySelector('[data-slot="fence"] > div') as HTMLElement;
    expect(body.childNodes).toHaveLength(1);
    expect(body.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(body.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
  });

  it("writes a bidi character of a hostile name out instead of drawing it", async () => {
    newBed();
    const page = await card({ triggerName: "evil\u202Egnp.exe" });
    expect(text(page.container)).toContain("evil\\u202Egnp.exe");
  });

  it("has no fence without a detail, and says origin, age, duration and cost in the meta line", async () => {
    newBed();
    const page = await card({ detail: null });
    expect(page.container.querySelector('[data-slot="fence"]')).toBeNull();
    expect(text(page.container)).toContain("webhook · 2 min · 2m00 · $0.21");
  });

  it("marks the current card with aria-current and the agent rule", async () => {
    newBed();
    const on = await card({}, () => {}, true);
    const li = on.container.querySelector("li") as HTMLElement;
    expect(li.getAttribute("aria-current")).toBe("true");
    expect(li.className).toContain("border-l-agent");
    await on.unmount();
    const off = await card();
    expect((off.container.querySelector("li") as HTMLElement).hasAttribute("aria-current")).toBe(false);
  });

  it("opens the session of a running task with Steer, and of a task that needs input with Reply", async () => {
    newBed();
    const opened = vi.fn();
    const steer = await card({}, opened);
    await click(button(steer.container, "Steer"));
    expect(opened).toHaveBeenCalledWith("s1", "t1");
    await steer.unmount();
    const reply = await card({ needsInput: true }, opened);
    expect(text(reply.container)).toContain("Input");
    await click(button(reply.container, "Reply"));
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued task at once with a commandId, and is disabled while the call is in flight", async () => {
    const bed = newBed();
    let settleCall: (value: unknown) => void = () => {};
    bed.handlers["automation.tasks.cancel"] = () =>
      new Promise((resolve) => {
        settleCall = resolve;
      });
    const page = await card({ state: "queued", startedAt: null });
    await click(button(page.container, "Cancel"));
    const calls = bed.called("automation.tasks.cancel");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ taskId: "t1" });
    expect(calls[0]?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(button(page.container, "Cancel").disabled).toBe(true);
    await click(button(page.container, "Cancel"));
    expect(bed.called("automation.tasks.cancel")).toHaveLength(1);
    settleCall({ taskId: "t1" });
    await settle();
    expect(button(page.container, "Cancel").disabled).toBe(false);
  });

  it("asks before it stops a running task, and sends nothing when the person keeps it running", async () => {
    const bed = newBed();
    const page = await card();
    await click(button(page.container, "Cancel"));
    expect(document.body.textContent).toContain("Stop this run?");
    expect(document.body.textContent).toContain("What it changed stays.");
    expect(bed.called("automation.tasks.cancel")).toHaveLength(0);
    await click(button(document.body, "Keep running"));
    expect(bed.called("automation.tasks.cancel")).toHaveLength(0);
    await click(button(page.container, "Cancel"));
    await click(button(document.body, "Stop run"));
    await settle();
    expect(bed.called("automation.tasks.cancel")).toHaveLength(1);
  });

  it("never draws Cancel as a danger button", async () => {
    newBed();
    const page = await card();
    expect(button(page.container, "Cancel").getAttribute("data-variant")).not.toBe("danger");
  });

  it("retries a failed task and shows the budget refusal in plain words", async () => {
    const bed = newBed();
    bed.handlers["automation.tasks.retry"] = () => {
      throw new RpcError("budget_reached");
    };
    const page = await card({ state: "failed" });
    await click(button(page.container, "Retry"));
    await settle();
    expect(bed.called("automation.tasks.retry")[0]?.params).toEqual({ taskId: "t1" });
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("budget");
  });

  it("says why a retry was refused by an unlisted trigger, in French too", async () => {
    const bed = newBed();
    bed.handlers["automation.tasks.retry"] = () => {
      throw new RpcError("conflict");
    };
    setLocale("fr");
    const page = await card({ state: "interrupted" });
    await click(button(page.container, "Relancer"));
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("déclencheur");
  });

  it("resumes a limited task now, or cancels the task, and never offers a bare Cancel resume", async () => {
    const bed = newBed();
    bed.handlers["usage.resumeNow"] = () => {
      throw new RpcError("automation_paused");
    };
    const page = await card({ state: "limited" });
    await click(button(page.container, "Resume now"));
    await settle();
    expect(bed.called("usage.resumeNow")[0]?.params).toEqual({ sessionId: "s1" });
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("paused");
    expect(hasButton(page.container, "Cancel resume")).toBe(false);
    await click(button(page.container, "Cancel task"));
    await settle();
    expect(document.body.textContent).not.toContain("Stop this run?");
    expect(bed.called("automation.tasks.cancel")[0]?.params).toEqual({ taskId: "t1" });
    expect(bed.called("usage.cancelResume")).toHaveLength(0);
    expect(hasButton(page.container, "Open")).toBe(true);
  });

  it("offers Cancel task on a limited task that has no session", async () => {
    const bed = newBed();
    const page = await card({ state: "limited", sessionId: null });
    expect(hasButton(page.container, "Resume now")).toBe(false);
    await click(button(page.container, "Cancel task"));
    await settle();
    expect(bed.called("automation.tasks.cancel")).toHaveLength(1);
  });

  it("shows 'normal tools' once the list is lifted and offers no button for it", async () => {
    newBed();
    const page = await card({ state: "done", toolsReleased: true });
    expect(text(page.container)).toContain("normal tools");
    expect(hasButton(page.container, "Use my normal tools")).toBe(false);
  });
});
