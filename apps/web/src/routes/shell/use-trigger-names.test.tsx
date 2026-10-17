// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { mount } from "../../testing/dom.ts";
import { useTriggerNames } from "./use-tasks-feed.ts";

const agent = (id: string, name: string, unread = 0): AgentSummary => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  state: "idle",
  unread,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
});

const counter = { renders: 0, last: new Map<string, string>() as ReadonlyMap<string, string> };
function Probe() {
  const names = useTriggerNames();
  // Runs after every render of this component that committed: the render counter.
  useEffect(() => {
    counter.renders += 1;
    counter.last = names;
  });
  return null;
}

beforeEach(() => {
  counter.renders = 0;
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
});

describe("useTriggerNames", () => {
  it("does not render its caller again for an unread tick or a state change, only for a new name", async () => {
    const apply = (event: unknown) => act(async () => useAgentsStore.getState().apply(event));
    await mount(<Probe />);
    await apply({
      kind: "snapshot",
      agents: [agent("atlas-1a2b", "atlas")],
      requests: [],
      truncated: false,
    });
    const afterSnapshot = counter.renders;
    expect(counter.last.get("agent:atlas-1a2b")).toBe("atlas");

    await apply({ kind: "agent", agent: { ...agent("atlas-1a2b", "atlas", 3), state: "running" } });
    await apply({ kind: "agent", agent: agent("atlas-1a2b", "atlas", 4) });
    expect(counter.renders).toBe(afterSnapshot);

    await apply({ kind: "agent", agent: agent("atlas-1a2b", "atlas two", 4) });
    expect(counter.renders).toBe(afterSnapshot + 1);
    expect(counter.last.get("agent:atlas-1a2b")).toBe("atlas two");
  });
});
