// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { field } from "../../testing/dom.ts";
import { current, newBed, projectOf, showWithStepUp } from "./board-bed.tsx";
import { knowProject } from "./editor-bed.tsx";
import { TriggerEditor } from "./TriggerEditor.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// A new trigger mounts the schedule form, whose time-zone select renders about 420 options (0.4 to 0.6 s unloaded).
const NEW_FORM_MS = 20_000;

beforeEach(() => {
  useTasksStore.getState().reset();
  useShellStore.setState({ view: EMPTY_SHELL });
});

describe("TriggerEditor: the home's prefill (decision 85)", () => {
  it("starts a new trigger with the name and prompt it was handed", { timeout: NEW_FORM_MS }, async () => {
    newBed();
    knowProject(projectOf("p1", "atlas"));
    const page = await showWithStepUp(
      <TriggerEditor
        triggerId="new:p1"
        prefill={{ name: "Nightly report", prompt: "Nightly report\nSummarise the failures" }}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
      />,
    );
    expect((field(page.container, "Name") as HTMLInputElement).value).toBe("Nightly report");
    expect((field(page.container, "Prompt") as HTMLTextAreaElement).value).toBe(
      "Nightly report\nSummarise the failures",
    );
    expect((field(page.container, "Folder") as HTMLInputElement).value).toBe("/work/atlas");
  });
});
