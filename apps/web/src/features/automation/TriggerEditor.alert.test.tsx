// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, field, settle, typeInto } from "../../testing/dom.ts";
import { current, newBed, prompt, showWithStepUp } from "./board-bed.tsx";
import { dryRunOf, viewOf } from "./editor-bed.tsx";
import { TriggerEditor } from "./TriggerEditor.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  useTasksStore.getState().reset();
  useShellStore.setState({ view: EMPTY_SHELL });
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("TriggerEditor: a failed save", () => {
  it("a failed trigger save is an alert", async () => {
    const bed = newBed();
    bed.handlers["automation.triggers.get"] = () => viewOf();
    bed.handlers["automation.journal"] = () => ({ entries: [], hasMore: false });
    bed.handlers["automation.dryRun"] = () => dryRunOf();
    bed.handlers["automation.triggers.update"] = () => {
      throw new RpcError("conflict");
    };
    const page = await showWithStepUp(
      <TriggerEditor triggerId="g1" onOpenSession={vi.fn()} onOpenTasks={vi.fn()} />,
    );
    await settle();
    await typeInto(field(page.container, "Prompt") as HTMLTextAreaElement, "Fixed");
    await click(button(page.container, "Save"));
    await settle();
    const failure = page.container.querySelector('[data-slot="inline-error"]');
    expect(failure?.getAttribute("role")).toBe("alert");
    expect(failure?.className).toContain("text-err");
  });
});
