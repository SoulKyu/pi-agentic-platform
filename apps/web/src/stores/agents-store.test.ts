// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { feedAgents, useAgents, useAgentsStore } from "./agents-store.ts";

beforeEach(() => useAgentsStore.getState().reset());

const agent = {
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
};

describe("feedAgents", () => {
  it("applies the events of the agents stream", async () => {
    const bed = fakeRuntime();
    feedAgents(bed.runtime.subscriptions);
    await flush();
    bed.fake.deliver({
      sub: "agents-sub",
      epoch: "e1",
      seq: 1,
      event: { kind: "snapshot", agents: [agent], requests: [], truncated: false },
    });
    expect(useAgentsStore.getState().view.agents.map((one) => one.id)).toEqual(["atlas-1a2b"]);
  });

  it("a refused subscription sets view.failed and calls onError once; a snapshot clears it", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.agents"] = () => {
      throw new RpcError("capacity");
    };
    const onError = vi.fn();
    feedAgents(bed.runtime.subscriptions, onError);
    await flush();
    expect(useAgentsStore.getState().view.failed).toBe("capacity");
    expect(onError).toHaveBeenCalledExactlyOnceWith("capacity");
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [], requests: [], truncated: false });
    expect(useAgentsStore.getState().view.failed).toBeNull();
  });
});

describe("useAgents", () => {
  it("reads one part of the view and follows it", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const Count = () => createElement("p", null, String(useAgents((view) => view.agents.length)));
    await act(async () => root.render(createElement(Count)));
    expect(host.textContent).toBe("0");
    await act(async () => {
      useAgentsStore.getState().apply({ kind: "agent", agent });
    });
    expect(host.textContent).toBe("1");
    await act(async () => root.unmount());
  });
});
