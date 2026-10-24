// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { button, click, text } from "../../testing/dom.ts";
import { agentOf, showWithStepUp } from "./board-bed.tsx";
import { DraftHarness, segmentOn } from "./editor-bed.tsx";
import { emptyDraft, toInput, type Draft } from "./editor.vm.ts";
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
    expect(text(page.container)).toContain("in a fresh session in Atlas's home");
  });

  it("says in one line each where a thread and an isolated task run", async () => {
    const page = await show(initial({ agentId: ATLAS.id, target: "thread", sourceType: "manual" }));
    expect(segmentOn(page.container, "Target")).toBe("Thread");
    expect(text(page.container)).toContain("in Atlas's thread, with its tools");
    await click(button(page.container, "Isolated task"));
    expect(text(page.container)).toContain(
      "in a fresh session in Atlas's home, with this tool list, unattended, in its sandbox",
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

describe("toInput with an agent", () => {
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
