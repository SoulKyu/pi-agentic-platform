// @vitest-environment happy-dom
import type { AgentSummary, VmStatusView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { agentVmEn } from "../../i18n/catalog/agent-vm.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

const summary = (id: string): AgentSummary => ({
  id,
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
});
const status = (patch: Partial<VmStatusView>): VmStatusView => ({
  usable: false,
  reason: "no kvm",
  vmdVersion: null,
  claudeToken: "missing",
  agents: [],
  ...patch,
});

let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  current.runtime = bed.runtime;
  localStorage.clear();
  useAgentsStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const railButtons = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="agent-rail"] button[aria-label]'),
];
async function show(vm: VmStatusView | null) {
  if (vm !== null) bed.handlers["agents.vmStatus"] = () => vm;
  const page = await renderShell("/");
  act(() => {
    useAgentsStore.getState().apply({
      kind: "snapshot",
      agents: [summary("atlas-1a2b"), summary("bolt-0001")],
      requests: [],
      truncated: false,
    });
  });
  await settle();
  return page;
}

describe("the agent rail when the VMs cannot run", () => {
  it("greys every agent out and carries the sentence", async () => {
    const page = await show(status({}));
    expect(railButtons()).toHaveLength(2);
    for (const one of railButtons()) {
      expect(one.getAttribute("aria-disabled")).toBe("true");
      expect(one.getAttribute("aria-label")).toContain(agentVmEn["agentVm.unusable"]);
    }
    await page.unmount();
  });

  it.each([
    ["VMs usable", status({ usable: true, reason: null })],
    ["no answer", null],
  ])("leaves the agents alone with %s", async (_name, vm) => {
    const page = await show(vm);
    for (const one of railButtons()) {
      expect(one.getAttribute("aria-disabled")).toBeNull();
      expect(one.getAttribute("aria-label")).not.toContain("sudo pap vm setup");
    }
    await page.unmount();
  });
});
