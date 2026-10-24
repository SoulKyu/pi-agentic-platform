// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { button, click, field, hasButton, text, typeInto } from "../../testing/dom.ts";
import { showWithStepUp } from "./board-bed.tsx";
import { DraftHarness, segmentOn } from "./editor-bed.tsx";
import { emptyDraft, type Draft } from "./editor.vm.ts";
import { ExecutionSection } from "./ExecutionSection.tsx";

const initial = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft("/work/atlas", "Europe/Paris"),
  ...over,
});

const show = (draft: Draft, errors: Record<string, string> = {}) =>
  showWithStepUp(
    <DraftHarness initial={draft}>
      {(current, set) => <ExecutionSection draft={current} set={set} errors={errors} />}
    </DraftHarness>,
  );

const tickbox = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-slot="checkbox"]')].find(
    (box) => box.textContent === name,
  ) as HTMLElement;

describe("ExecutionSection: target and folder", () => {
  it("keeps a project trigger on its folder, with no target to choose", async () => {
    const page = await show(initial());
    expect(segmentOn(page.container, "Target")).toBeNull();
    expect((field(page.container, "Folder") as HTMLInputElement).value).toBe("/work/atlas");
  });
});

describe("ExecutionSection: tools", () => {
  it("lists Pi's seven tools, strikes through those left out, and takes added names", async () => {
    const page = await show(initial());
    const struck = [...page.container.querySelectorAll('[data-tool-off="true"]')].map(
      (row) => row.textContent,
    );
    expect(struck).toEqual(["bash", "edit", "write"]);

    await typeInto(field(page.container, "Add a tool name") as HTMLInputElement, "kubectl__get");
    await click(button(page.container, "Add tool"));
    expect(tickbox(page.container, "kubectl__get")).toBeDefined();

    await typeInto(field(page.container, "Add a tool name") as HTMLInputElement, "not a name!");
    await click(button(page.container, "Add tool"));
    expect(text(page.container)).toContain("This is not a tool name.");
  });

  it("tells exactly what asks under each mode once bash is listed, and not before", async () => {
    const page = await show(initial({ tools: ["read", "grep", "find", "ls"], mode: "supervised" }));
    expect(text(page.container)).not.toContain("Each call asks you");
    await click(tickbox(page.container, "bash").querySelector("button") as HTMLElement);
    expect(text(page.container)).toContain(
      "Each call asks you (Inbox); unanswered after 10 minutes, it is denied",
    );
    // bash is not one of Pi's read tools: the preset is off, the mode decides
    expect(text(page.container)).toContain("The read-only preset is off");
    await click(button(page.container, "Read-only"));
    expect(text(page.container)).toContain("Blocked: this mode never runs them");
    await click(button(page.container, "Auto-accept edits"));
    expect(text(page.container)).toContain(
      "edit and write inside the folder run without asking; bash asks you (Inbox)",
    );
  });

  it("shows the preset note when a name other than read grep find ls is listed", async () => {
    const page = await show(initial({ tools: ["read", "kubectl__apply"] }));
    expect(text(page.container)).toContain("The read-only preset is off: calls follow the approval mode");
  });
});

describe("ExecutionSection: mode and budget", () => {
  it("pre-sets the mode and the dollar cap from the source, and keeps an explicit choice", async () => {
    const web = await show(initial({ sourceType: "webhook" }));
    expect(segmentOn(web.container, "Approval mode")).toBe("Supervised");
    expect((field(web.container, "Max dollars per run") as HTMLInputElement).value).toBe("1");

    const sched = await show(initial());
    expect(segmentOn(sched.container, "Approval mode")).toBe("Auto-accept edits");
    expect((field(sched.container, "Max dollars per run") as HTMLInputElement).value).toBe("");

    await click(button(web.container, "Auto-accept edits"));
    expect(segmentOn(web.container, "Approval mode")).toBe("Auto-accept edits");
  });

  it("offers 'No cap' as a choice, and the interrupted choice", async () => {
    const page = await show(initial({ sourceType: "webhook" }));
    await click(tickbox(page.container, "No cap").querySelector("button") as HTMLElement);
    expect((field(page.container, "Max dollars per run") as HTMLInputElement).value).toBe("");
    await click(button(page.container, "Retry"));
    expect(segmentOn(page.container, "If interrupted")).toBe("Retry");
  });
});

describe("ExecutionSection: prechecks were removed", () => {
  it("shows no precheck field and no variable names for a trigger without a precheck", async () => {
    const page = await show(initial());
    expect(text(page.container)).not.toContain("Precheck");
    expect(text(page.container)).not.toContain("Variable");
    expect(text(page.container)).not.toContain("Prechecks were removed");
    const agent = await show(initial({ agentId: "atlas-1a2b", target: "isolated" }));
    expect(text(agent.container)).not.toContain("Precheck");
  });

  it("shows a stored precheck read-only with the hint, and clears it with its variable names", async () => {
    const page = await show(initial({ precheck: "kubectl get pods", env: ["KUBECONFIG"] }));
    const stored = field(page.container, "Precheck") as HTMLTextAreaElement;
    expect(stored.value).toBe("kubectl get pods");
    expect(stored.disabled).toBe(true);
    expect(text(page.container)).toContain("Prechecks were removed: clear this field.");
    await click(button(page.container, "Clear"));
    expect(hasButton(page.container, "Clear")).toBe(false);
    expect(text(page.container)).not.toContain("Precheck");
  });
});
