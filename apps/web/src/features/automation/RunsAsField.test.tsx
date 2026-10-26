// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { button, click, text } from "../../testing/dom.ts";
import { agentOf, showWithStepUp } from "./board-bed.tsx";
import { DraftHarness, segmentOn } from "./editor-bed.tsx";
import { emptyDraft, toInput, type Draft } from "./editor.vm.ts";
import { automationAgentsFr } from "../../i18n/catalog/automation-agents.ts";
import { ExecutionSection } from "./ExecutionSection.tsx";

const ATLAS = agentOf("atlas-1a2b", "Atlas");
const initial = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft("/work/atlas", "Europe/Paris"),
  ...over,
});
const show = (draft: Draft) =>
  showWithStepUp(
    <DraftHarness initial={draft}>
      {(current, set) => <ExecutionSection draft={current} set={set} errors={{}} />}
    </DraftHarness>,
  );

beforeEach(() => {
  useAgentsStore.getState().reset();
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [ATLAS], requests: [], truncated: false });
  });
});

describe("RunsAsField", () => {
  it("offers a project folder or an agent, and shows the folder only for a project", async () => {
    const page = await show(initial());
    expect(segmentOn(page.container, "Runs as")).toBe("Project folder");
    expect(page.container.querySelector("input[value='/work/atlas']")).not.toBeNull();
    await click(button(page.container, "Agent"));
    expect(segmentOn(page.container, "Runs as")).toBe("Agent");
    expect(page.container.querySelector("input[value='/work/atlas']")).toBeNull();
    expect(text(page.container)).toContain("in a fresh session in Atlas's own microVM");
  });

  it("says in one line each where a thread and an isolated task run", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "manual" }));
    expect(segmentOn(page.container, "Target")).toBe("Thread");
    expect(text(page.container)).toContain("in Atlas's thread, with its tools");
    await click(button(page.container, "Isolated task"));
    expect(text(page.container)).toContain(
      "in a fresh session in Atlas's own microVM, with this tool list, unattended, in its sandbox",
    );
  });

  it("shows Isolated only for a webhook, with the reason", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "webhook" }));
    expect(page.container.textContent).not.toContain("Thread");
    expect(segmentOn(page.container, "Target")).toBe("Isolated task");
    expect(text(page.container)).toContain("outside text never reaches an agent's thread");
  });

  it("shows Isolated only for a feed too", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "feed" }));
    expect(segmentOn(page.container, "Target")).toBe("Isolated task");
  });

  it("hides the tool list for a thread and shows it for an isolated task", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "manual" }));
    expect(text(page.container)).not.toContain("Allowed tools");
    await click(button(page.container, "Isolated task"));
    expect(text(page.container)).toContain("Allowed tools");
  });

  it("says prechecks were removed on a stored precheck, an agent's or a project's", async () => {
    const agent = await show(initial({ agentId: ATLAS.id, target: "isolated", precheck: "true" }));
    expect(text(agent.container)).toContain("Prechecks were removed: clear this field.");
    const project = await show(initial({ precheck: "true" }));
    expect(text(project.container)).toContain("Prechecks were removed: clear this field.");
  });

  it("hides the Mode control for a thread target, keeps it for isolated, ", async () => {
    const thread = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "manual" }));
    expect(segmentOn(thread.container, "Approval mode")).toBeNull();
    expect(text(thread.container)).not.toContain("Precheck");
    const isolated = await show(initial({ agentId: ATLAS.id, target: "isolated" }));
    expect(segmentOn(isolated.container, "Approval mode")).not.toBeNull();
  });

  it("offers no agent when the owner has none", async () => {
    act(() => useAgentsStore.getState().reset());
    const page = await show(initial());
    expect(page.container.querySelector('[aria-label="Runs as"]')).toBeNull();
  });
});

const keepOf = (container: ParentNode) =>
  [...container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
    (node) =>
      container.querySelector(`#${node.getAttribute("aria-labelledby") ?? "none"}`)?.textContent ===
      "Keep its folder between runs",
  ) ?? null;

describe("the keep switch", () => {
  it("shows only for an agent's isolated task, with the exact copy", async () => {
    const isolated = await show(initial({ agentId: ATLAS.id, target: "isolated", sourceType: "manual" }));
    expect(keepOf(isolated.container)).not.toBeNull();
    expect(text(isolated.container)).toContain(
      "Each run finds what the previous one left. Every run starts as untrusted.",
    );
    const thread = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "manual" }));
    expect(keepOf(thread.container)).toBeNull();
    const project = await show(initial());
    expect(keepOf(project.container)).toBeNull();
  });

  it("shows for a feed, which forces isolated", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "feed" }));
    expect(keepOf(page.container)).not.toBeNull();
  });

  it("toggles on, and turns off and clears when the target becomes Thread", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "isolated", sourceType: "manual" }));
    expect(keepOf(page.container)?.getAttribute("aria-checked")).toBe("false");
    const keep = keepOf(page.container);
    if (keep === null) throw new Error("no keep switch");
    await click(keep);
    expect(keepOf(page.container)?.getAttribute("aria-checked")).toBe("true");
    await click(button(page.container, "Thread"));
    await click(button(page.container, "Isolated task"));
    expect(keepOf(page.container)?.getAttribute("aria-checked")).toBe("false");
  });

  it("has the exact French copy", () => {
    expect(automationAgentsFr["automation.editor.keep"]).toBe("Garder son dossier entre les runs");
    expect(automationAgentsFr["automation.editor.keep.hint"]).toBe(
      "Chaque run retrouve ce que le précédent a laissé. Chaque run démarre comme non fiable. Désactiver l'option, ou changer d'agent ou de cible, supprime définitivement le dossier, sans confirmation.",
    );
  });

  it("shows on for a draft that has keep", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "isolated", keep: true }));
    expect(keepOf(page.container)?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("toInput with an agent", () => {
  const base0 = { name: "n", prompt: "Look" };
  it("sends keep only with an isolated agent target", () => {
    const on = toInput(initial({ ...base0, agentId: ATLAS.id, target: "isolated", keep: true }));
    expect(on.ok && on.input.execution.agent).toEqual({ agentId: ATLAS.id, keep: true, target: "isolated" });
    const off = toInput(initial({ ...base0, agentId: ATLAS.id, target: "isolated" }));
    expect(off.ok && off.input.execution.agent).toEqual({ agentId: ATLAS.id, target: "isolated" });
    const thread = toInput(
      initial({ ...base0, agentId: ATLAS.id, target: "thread", sourceType: "manual", keep: true }),
    );
    expect(thread.ok && thread.input.execution.agent).toEqual({ agentId: ATLAS.id, target: "thread" });
  });

  const base = { name: "n", prompt: "Look" };
  it("sends the agent and the target, and no cwd", () => {
    const result = toInput(initial({ ...base, agentId: ATLAS.id, target: "isolated" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.execution.agent).toEqual({ agentId: ATLAS.id, target: "isolated" });
    expect(result.input.execution.cwd).toBeUndefined();
  });

  it("drops the mode for a thread target: the agent's own mode applies", () => {
    const thread = { ...base, agentId: ATLAS.id, target: "thread" as const, sourceType: "manual" as const };
    const picked = toInput(initial({ ...thread, mode: "read-only" }));
    const untouched = toInput(initial({ ...thread, mode: null }));
    expect(picked.ok && untouched.ok).toBe(true);
    if (!picked.ok || !untouched.ok) return;
    expect(picked.input.execution.mode).toEqual(untouched.input.execution.mode);
    const isolated = toInput(initial({ ...base, agentId: ATLAS.id, target: "isolated", mode: "read-only" }));
    expect(isolated.ok && isolated.input.execution.mode).toBe("read-only");
  });

  it("sends a folder and no agent for a project", () => {
    const result = toInput(initial(base));
    expect(result.ok && result.input.execution.cwd).toBe("/work/atlas");
    expect(result.ok && result.input.execution.agent).toBeNull();
  });

  it("runs a webhook as an isolated task even when the draft still says thread", () => {
    const result = toInput(initial({ ...base, agentId: ATLAS.id, target: "thread", sourceType: "webhook" }));
    expect(result.ok && result.input.execution.agent?.target).toBe("isolated");
  });

  it("refuses {{precheck}} on a thread in pap's words, before the save", () => {
    const result = toInput(
      initial({
        ...base,
        prompt: "Look {{precheck}}",
        precheck: "true",
        agentId: ATLAS.id,
        target: "thread",
        sourceType: "manual",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["prompt"]).toContain("A thread trigger cannot use {{precheck}}");
    expect(result.errors["prompt"]).toContain("isolated task");
  });

  it("refuses {{precheck}} for an isolated task too: prechecks were removed", () => {
    const result = toInput(
      initial({ ...base, prompt: "Look {{precheck}}", agentId: ATLAS.id, target: "isolated" }),
    );
    expect(result.ok).toBe(false);
  });

  it("drops the tool list for a thread target, which runs with the agent's own tools", () => {
    const tools = ["read", "bash"];
    const thread = toInput(
      initial({ ...base, tools, agentId: ATLAS.id, target: "thread", sourceType: "manual" }),
    );
    expect(thread.ok && thread.input.execution.tools).not.toContain("bash");
    const isolated = toInput(initial({ ...base, tools, agentId: ATLAS.id, target: "isolated" }));
    expect(isolated.ok && isolated.input.execution.tools).toEqual(tools);
  });
});
