// @vitest-environment happy-dom
import { TriggerInput } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, settle, text } from "../../testing/dom.ts";
import { agentOf, current, newBed, prompt, showWithStepUp } from "./board-bed.tsx";
import { dryRunOf, SECRET, viewOf } from "./editor-bed.tsx";
import { TriggerEditor } from "./TriggerEditor.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ATLAS = agentOf("atlas-1a2b", "Atlas");
const AGENT_INPUT = TriggerInput.parse({
  name: "morning",
  enabled: true,
  source: { type: "manual" },
  execution: { agent: { agentId: ATLAS.id, target: "isolated" } },
  prompt: "Summarise the night",
});
const AGENT_VIEW = viewOf({
  id: "g9",
  name: "morning",
  source: AGENT_INPUT.source,
  execution: AGENT_INPUT.execution,
  prompt: AGENT_INPUT.prompt,
  projectId: null,
  cwd: "/home/atlas",
  agent: { agentId: ATLAS.id, target: "isolated" },
  webhookUrl: null,
  secretRotatedAt: null,
});
const NEW_FORM_MS = 20_000;

beforeEach(() => {
  useTasksStore.getState().reset();
  useShellStore.setState({ view: EMPTY_SHELL });
  useAgentsStore.getState().reset();
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [ATLAS], requests: [], truncated: false });
  });
  prompt.answer = true;
});

describe("TriggerEditor: an agent trigger", () => {
  it("saves it back as an agent trigger with no cwd", async () => {
    const bed = newBed();
    bed.handlers["automation.triggers.get"] = () => AGENT_VIEW;
    bed.handlers["automation.journal"] = () => ({ entries: [], hasMore: false });
    bed.handlers["automation.triggers.update"] = () => ({ trigger: AGENT_VIEW, secret: null });
    const page = await showWithStepUp(
      <TriggerEditor triggerId="g9" onOpenSession={vi.fn()} onOpenTasks={vi.fn()} />,
    );
    await settle();
    expect(text(page.container)).toContain("in a fresh session in Atlas's own microVM");
    await click(button(page.container, "Save"));
    await settle();
    const sent = bed.called("automation.triggers.update")[0]?.params as {
      input: { execution: { cwd?: string; agent: unknown } };
    };
    expect(sent.input.execution.agent).toEqual({ agentId: ATLAS.id, target: "isolated" });
    expect(sent.input.execution.cwd).toBeUndefined();
  });

  it("starts a new trigger prefilled with the agent", { timeout: NEW_FORM_MS }, async () => {
    const bed = newBed();
    bed.handlers["automation.triggers.create"] = () => ({ trigger: AGENT_VIEW, secret: SECRET });
    bed.handlers["automation.dryRun"] = () => dryRunOf();
    const page = await showWithStepUp(
      <TriggerEditor triggerId={`new:agent:${ATLAS.id}`} onOpenSession={vi.fn()} onOpenTasks={vi.fn()} />,
    );
    expect(text(page.container)).toContain("in a fresh session in Atlas's own microVM");
    expect(page.container.querySelector("input[value='/work/atlas']")).toBeNull();
  });
});
