// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { QueueTaskDialog } from "./QueueTaskDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.queueTask"] = () => ({ taskId: "t1" });
});
const show = async (paused = false, onClose = vi.fn()) => {
  const page = await mount(
    <QueueTaskDialog agentId="atlas-1a2b" agentName="Atlas" paused={paused} onClose={onClose} />,
  );
  await settle();
  return { page, onClose };
};
const body = () => text(document.body);

describe("the Queue task dialog (M11R124)", () => {
  it("queues the prompt for this agent and closes", async () => {
    const { onClose } = await show();
    await typeInto(field(document.body, "Prompt") as HTMLTextAreaElement, "tidy the logs");
    await click(button(document.body, "Queue"));
    await settle();
    expect(bed.called("agents.queueTask")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b", prompt: "tidy the logs" } }),
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Queue off while the prompt is blank", async () => {
    await show();
    expect(button(document.body, "Queue").disabled).toBe(true);
  });

  it("starts the counter above 10 000 characters and stops the field at 20 000", async () => {
    await show();
    const prompt = field(document.body, "Prompt") as HTMLTextAreaElement;
    await typeInto(prompt, "x".repeat(10_000));
    expect(body()).not.toContain("/ 20 000");
    await typeInto(prompt, "x".repeat(10_001));
    expect(body()).toContain("10 001 / 20 000");
    await typeInto(prompt, "x".repeat(20_500));
    expect(prompt.value.length).toBe(20_000);
  });

  it("tells a paused agent's owner that the task runs when it is resumed", async () => {
    await show(true);
    expect(body()).toContain("queued, runs when resumed");
  });

  it("does not say that for an agent that is running", async () => {
    await show(false);
    expect(body()).not.toContain("runs when resumed");
  });

  it("shows a refusal in words and stays open with the text", async () => {
    bed.handlers["agents.queueTask"] = () => {
      throw new RpcError("rate_limited");
    };
    const { onClose } = await show();
    await typeInto(field(document.body, "Prompt") as HTMLTextAreaElement, "again");
    await click(button(document.body, "Queue"));
    await settle();
    expect(alerts(document.body)).not.toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect((field(document.body, "Prompt") as HTMLTextAreaElement).value).toBe("again");
  });
});
