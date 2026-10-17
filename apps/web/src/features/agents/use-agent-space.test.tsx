// @vitest-environment happy-dom
import type { AgentEventView } from "@pap/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { useAgentCards } from "./use-agent-space.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const notify = (id: number, text: string) => ({
  id,
  at: 1,
  taskId: null,
  kind: "notify",
  data: { text, itemId: `item-${id}` },
});

describe("useAgentCards", () => {
  it("drops the cards of the agent it showed as soon as the agent changes, before the new read answers", async () => {
    const bed = fakeRuntime("open");
    current.runtime = bed.runtime;
    let release: (page: unknown) => void = () => {};
    bed.handlers["agents.events"] = (params) =>
      (params as { agentId: string }).agentId === "atlas-1a2b"
        ? { events: [notify(1, "from atlas")], more: false, next: null }
        : new Promise((resolve) => {
            release = resolve;
          });
    let shown: readonly AgentEventView[] = [];
    function Probe({ agentId }: { readonly agentId: string }) {
      shown = useAgentCards(agentId, 0);
      return null;
    }
    const page = await mount(<Probe agentId="atlas-1a2b" />);
    await settle();
    expect(shown.map((card) => card.id)).toEqual([1]);

    await page.rerender(<Probe agentId="scout-2b2b" />);
    expect(shown).toEqual([]);

    await act(async () => release({ events: [notify(2, "from scout")], more: false, next: null }));
    await settle();
    expect(shown.map((card) => card.id)).toEqual([2]);
  });
});
