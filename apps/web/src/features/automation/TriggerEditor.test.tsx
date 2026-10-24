// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, field, hasButton, settle, text, typeInto } from "../../testing/dom.ts";
import { current, newBed, projectOf, prompt, showWithStepUp } from "./board-bed.tsx";
import { dryRunOf, knowProject, SECRET, viewOf } from "./editor-bed.tsx";
import { TriggerEditor } from "./TriggerEditor.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const props = () => ({ onOpenSession: vi.fn(), onOpenTasks: vi.fn() });
// A new trigger mounts the schedule form, whose time-zone select renders about 420 options (0.4 to 0.6 s unloaded).
const NEW_FORM_MS = 20_000;

function saved(bed: ReturnType<typeof newBed>, view = viewOf()) {
  bed.handlers["automation.triggers.get"] = () => view;
  bed.handlers["automation.journal"] = () => ({ entries: [], hasMore: false });
  bed.handlers["automation.dryRun"] = () => dryRunOf();
  bed.handlers["trust.status"] = () => ({
    requiresTrust: true,
    decision: true,
    decisionPath: "/work/atlas",
    inherited: false,
    resources: {},
  });
}

beforeEach(() => {
  useTasksStore.getState().reset();
  useShellStore.setState({ view: EMPTY_SHELL });
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("TriggerEditor: loading", () => {
  it("opens a saved trigger with its name, prompt and webhook URL", async () => {
    const bed = newBed();
    saved(bed);
    const page = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    expect(bed.called("automation.triggers.get")[0]?.params).toEqual({ triggerId: "g1" });
    expect((field(page.container, "Name") as HTMLInputElement).value).toBe("prod-alerts");
    expect(text(page.container)).toContain("https://pap.home.arpa/hooks/g1");
    expect(page.container.querySelector("[data-trigger-editor]")).not.toBeNull();
  });

  it("says so when the trigger is gone or its settings no longer parse", async () => {
    const bed = newBed();
    bed.handlers["automation.triggers.get"] = () => {
      throw new RpcError("not_found");
    };
    const gone = await showWithStepUp(<TriggerEditor triggerId="nope" {...props()} />);
    await settle();
    expect(text(gone.container)).toContain("This trigger could not be loaded.");

    saved(bed, viewOf({ state: "unreadable", source: null, execution: null, prompt: null }));
    const broken = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    expect(text(broken.container)).toContain("can no longer be read");
    expect(hasButton(broken.container, "Save")).toBe(false);
  });

  it(
    "starts a new trigger in the project's folder, as a schedule in the browser's zone",
    { timeout: NEW_FORM_MS },
    async () => {
      newBed();
      knowProject(projectOf("p1", "atlas"));
      const page = await showWithStepUp(<TriggerEditor triggerId="new:p1" {...props()} />);
      expect((field(page.container, "Folder") as HTMLInputElement).value).toBe("/work/atlas");
      expect(text(page.container)).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    },
  );
});

describe("TriggerEditor: Save", () => {
  it(
    "asks for the password when the daemon wants it, then retries the save once and shows the secret once",
    { timeout: NEW_FORM_MS },
    async () => {
      const bed = newBed();
      knowProject(projectOf("p1", "atlas"));
      saved(bed);
      let calls = 0;
      bed.handlers["automation.triggers.create"] = () => {
        calls += 1;
        if (calls === 1) throw new RpcError("step_up_required");
        return { trigger: viewOf({ revision: 1 }), secret: SECRET };
      };
      const page = await showWithStepUp(<TriggerEditor triggerId="new:p1" {...props()} />);
      await typeInto(field(page.container, "Name") as HTMLInputElement, "prod-alerts");
      await typeInto(field(page.container, "Prompt") as HTMLTextAreaElement, "Investigate");
      await click(button(page.container, "Save"));
      await settle();

      expect(prompt.asked).toBe(1);
      expect(bed.called("automation.triggers.create")).toHaveLength(2);
      const sent = bed.called("automation.triggers.create")[1]?.params as { input: { name: string } };
      expect(sent.input.name).toBe("prod-alerts");

      // the secret is in a dialog, once, with the instruction to copy it
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("Copy it now: pap does not show it again.");
      expect((dialog?.querySelector("input[readonly]") as HTMLInputElement).value).toBe(SECRET);
      await click(button(dialog as HTMLElement, "Done"));
      await settle();
      expect(document.body.textContent).not.toContain(SECRET);
      expect(document.body.querySelector("input[readonly]")).toBeNull();
      expect(JSON.stringify(location)).not.toContain(SECRET);
    },
  );

  it(
    "does not save when the person cancels the password prompt, and shows no secret",
    { timeout: NEW_FORM_MS },
    async () => {
      const bed = newBed();
      knowProject(projectOf("p1", "atlas"));
      prompt.answer = false;
      bed.handlers["automation.triggers.create"] = () => {
        throw new RpcError("step_up_required");
      };
      const page = await showWithStepUp(<TriggerEditor triggerId="new:p1" {...props()} />);
      await typeInto(field(page.container, "Name") as HTMLInputElement, "x");
      await typeInto(field(page.container, "Prompt") as HTMLTextAreaElement, "y");
      await click(button(page.container, "Save"));
      await settle();
      expect(bed.called("automation.triggers.create")).toHaveLength(1);
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("updates a saved trigger with its revision and shows no secret when none comes back", async () => {
    const bed = newBed();
    saved(bed);
    bed.handlers["automation.triggers.update"] = () => ({ trigger: viewOf({ revision: 4 }), secret: null });
    const page = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "prod-alerts v2");
    await click(button(page.container, "Save"));
    await settle();
    const sent = bed.called("automation.triggers.update")[0]?.params as {
      triggerId: string;
      baseRevision: number;
    };
    expect([sent.triggerId, sent.baseRevision]).toEqual(["g1", 3]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(text(page.container)).toContain("Saved");
  });

  it("shows the fixed text of a refusal, and the prompt error before anything is sent", async () => {
    const bed = newBed();
    saved(bed);
    bed.handlers["automation.triggers.update"] = () => {
      throw new RpcError("conflict");
    };
    const page = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    await typeInto(field(page.container, "Prompt") as HTMLTextAreaElement, "Result {{precheck}}");
    await click(button(page.container, "Save"));
    await settle();
    expect(text(page.container)).toContain("Prechecks were removed: take {{precheck}} out of the prompt.");
    expect(bed.called("automation.triggers.update")).toHaveLength(0);

    await typeInto(field(page.container, "Prompt") as HTMLTextAreaElement, "Fixed");
    await click(button(page.container, "Save"));
    await settle();
    expect(text(page.container)).toContain("changed elsewhere");
  });
});

describe("TriggerEditor: after the first save", () => {
  async function created(
    onCreated = vi.fn(),
    answer: unknown = { trigger: viewOf({ id: "g9", revision: 1 }), secret: SECRET },
  ) {
    const bed = newBed();
    knowProject(projectOf("p1", "atlas"));
    saved(bed);
    bed.handlers["automation.triggers.create"] = () => answer;
    bed.handlers["automation.triggers.update"] = () => ({
      trigger: viewOf({ id: "g9", revision: 2 }),
      secret: null,
    });
    const page = await showWithStepUp(
      <TriggerEditor triggerId="new:p1" {...props()} onCreated={onCreated} />,
    );
    await typeInto(field(page.container, "Name") as HTMLInputElement, "prod-alerts");
    await typeInto(field(page.container, "Prompt") as HTMLTextAreaElement, "Investigate");
    await click(button(page.container, "Save"));
    await settle();
    return { bed, page, onCreated };
  }

  it(
    "swaps the new: tab for the trigger's own only once the secret dialog is closed",
    { timeout: NEW_FORM_MS },
    async () => {
      const { page, onCreated } = await created();
      expect(onCreated).not.toHaveBeenCalled();
      await click(button(document.body.querySelector('[role="dialog"]') as HTMLElement, "Done"));
      await settle();
      expect(onCreated).toHaveBeenCalledExactlyOnceWith("g9");
      expect(page.container.querySelector("[data-trigger-editor]")).not.toBeNull();
    },
  );

  it(
    "a second Save updates the trigger it created instead of creating another",
    { timeout: NEW_FORM_MS },
    async () => {
      const { bed, page } = await created();
      await click(button(document.body.querySelector('[role="dialog"]') as HTMLElement, "Done"));
      await typeInto(field(page.container, "Name") as HTMLInputElement, "prod-alerts v2");
      await click(button(page.container, "Save"));
      await settle();
      expect(bed.called("automation.triggers.create")).toHaveLength(1);
      const sent = bed.called("automation.triggers.update")[0]?.params as {
        triggerId: string;
        baseRevision: number;
      };
      expect([sent.triggerId, sent.baseRevision]).toEqual(["g9", 1]);
    },
  );

  it(
    "still shows the secret when the created trigger's view cannot be read",
    { timeout: NEW_FORM_MS },
    async () => {
      const onCreated = vi.fn();
      await created(onCreated, { trigger: { broken: true }, secret: SECRET });
      const dialog = document.body.querySelector('[role="dialog"]');
      expect((dialog?.querySelector("input[readonly]") as HTMLInputElement).value).toBe(SECRET);
      expect(onCreated).not.toHaveBeenCalled();
    },
  );
});

describe("TriggerEditor: Rotation and Fire now", () => {
  it("asks before rotating, then shows the new secret once", async () => {
    const bed = newBed();
    saved(bed);
    bed.handlers["automation.triggers.rotateSecret"] = () => ({ secret: SECRET });
    const page = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    await click(button(page.container, "Rotate secret"));
    expect(document.body.textContent).toContain("The old secret stops working at once.");
    expect(bed.called("automation.triggers.rotateSecret")).toHaveLength(0);
    await click(button(document.body, "Rotate"));
    await settle();
    expect(bed.called("automation.triggers.rotateSecret")[0]?.params).toEqual({ triggerId: "g1" });
    expect((document.body.querySelector("input[readonly]") as HTMLInputElement).value).toBe(SECRET);
  });

  it("keeps the old secret when the person says no to the rotation", async () => {
    const bed = newBed();
    saved(bed);
    const page = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    await click(button(page.container, "Rotate secret"));
    await click(button(document.body, "Keep it"));
    await settle();
    expect(bed.called("automation.triggers.rotateSecret")).toHaveLength(0);
  });

  it("fires the saved trigger, and disables Fire now as soon as the form has an unsaved change", async () => {
    const bed = newBed();
    saved(bed);
    bed.handlers["automation.fire"] = () => ({ verdict: "fired", taskId: "t9" });
    const page = await showWithStepUp(<TriggerEditor triggerId="g1" {...props()} />);
    await settle();
    expect(button(page.container, "Fire now").disabled).toBe(false);
    await click(button(page.container, "Fire now"));
    await settle();
    expect(bed.called("automation.fire")[0]?.params).toEqual({ triggerId: "g1" });
    expect(text(page.container)).toContain("Fired.");
    expect(bed.called("automation.journal").length).toBeGreaterThan(1);

    await typeInto(field(page.container, "Name") as HTMLInputElement, "prod-alerts!");
    expect(button(page.container, "Fire now").disabled).toBe(true);
  });

  it("cannot fire a trigger that is not saved yet", async () => {
    newBed();
    knowProject(projectOf("p1", "atlas"));
    const page = await showWithStepUp(<TriggerEditor triggerId="new:p1" {...props()} />);
    expect(button(page.container, "Fire now").disabled).toBe(true);
    await act(async () => {});
  });
});
