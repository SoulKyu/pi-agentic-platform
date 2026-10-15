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
  it("fixes the target on an isolated task and shows the agent thread as coming later", async () => {
    const page = await show(initial());
    expect(segmentOn(page.container, "Target")).toBe("Isolated task");
    expect(button(page.container, "Agent thread · arrives with agents").disabled).toBe(true);
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

describe("ExecutionSection: precheck and its variables", () => {
  it("shows the credential refusal for GH_TOKEN, refuses A-B, and takes a plain name", async () => {
    const page = await show(initial({ precheck: "true" }));
    expect(text(page.container)).toContain("Never passed: the SSH agent, provider and cloud keys");
    const name = field(page.container, "Variable name") as HTMLInputElement;

    await typeInto(name, "GH_TOKEN");
    await click(button(page.container, "Add variable"));
    expect(text(page.container)).toContain("GH_TOKEN looks like a credential or is withheld.");

    await typeInto(name, "A-B");
    await click(button(page.container, "Add variable"));
    expect(text(page.container)).toContain("This is not a variable name.");

    await typeInto(name, "KUBECONFIG");
    await click(button(page.container, "Add variable"));
    expect(hasButton(page.container, "Remove KUBECONFIG")).toBe(true);
    await click(button(page.container, "Remove KUBECONFIG"));
    expect(hasButton(page.container, "Remove KUBECONFIG")).toBe(false);
  });

  it("says the precheck is not run for webhooks and shows the contract's error under it", async () => {
    const page = await show(initial(), { "execution.precheck": "visible text, tabs and new lines only" });
    expect(text(page.container)).toContain("Not run for webhooks.");
    expect(text(page.container)).toContain("visible text, tabs and new lines only");
  });
});
