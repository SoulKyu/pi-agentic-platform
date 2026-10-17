// @vitest-environment happy-dom
import { AgentInput, EGRESS_UNKNOWN, type AgentSummary, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentSettingsView } from "./AgentSettingsView.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const summary = (lastActivityAt: number): AgentSummary => ({
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt,
});
const view: AgentView = {
  id: "atlas-1a2b",
  name: "Atlas",
  input: AgentInput.parse({ name: "Atlas", role: "Tidy.", model: null }),
  state: "active",
  threadSessionId: "s1",
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};
const probe = {
  usable: true,
  path: "/usr/bin/bwrap",
  reason: null,
  checkedAt: 1,
  egress: EGRESS_UNKNOWN,
} as const;

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.get"] = () => view;
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  bed.handlers["policy.getSettings"] = () => ({ value: { allowHosts: null }, revision: 1 });
});

const tree = (at: number) => (
  <TooltipProvider>
    <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
      <AgentSettingsView
        agentId="atlas-1a2b"
        summary={summary(at)}
        probe={probe}
        presetField={() => null}
        after={<input aria-label="Secret name" />}
      />
    </StepUpContext.Provider>
  </TooltipProvider>
);

describe("the agent's settings keep the focus where the owner is (T25 review)", () => {
  it("focuses the heading once the agent has loaded", async () => {
    await mount(tree(1));
    await settle();
    expect(document.activeElement?.tagName).toBe("H3");
  });

  it("does not pull the focus back to the heading on a ready, failed, ready reload", async () => {
    const page = await mount(tree(1));
    await settle();
    // The owner moved on to another field (the agent form's own, or the secrets' below it).
    const typing = page.container.querySelector<HTMLInputElement>('input[aria-label="Secret name"]');
    expect(typing).not.toBeNull();
    typing?.focus();
    bed.handlers["agents.get"] = () => {
      throw new RpcError("internal");
    };
    await act(async () => {
      await page.rerender(tree(2));
    });
    await settle();
    bed.handlers["agents.get"] = () => view;
    const outside = document.body.appendChild(document.createElement("input"));
    outside.focus();
    await act(async () => {
      await page.rerender(tree(3));
    });
    await settle();
    expect(page.container.querySelector("h3")).not.toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
