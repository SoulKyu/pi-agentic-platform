// @vitest-environment happy-dom
import { AgentInput, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { NewAgentDialog } from "./NewAgentDialog.tsx";

const current: { runtime: Runtime | undefined } = { runtime: undefined };
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const created: AgentView = {
  id: "atlas-1a2b",
  name: "atlas",
  input: AgentInput.parse({ name: "atlas" }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

async function open(usable = true) {
  const bed = fakeRuntime();
  bed.handlers["agents.vmStatus"] = () => ({
    usable,
    reason: usable ? null : "no kvm",
    vmdVersion: null,
    claudeToken: "missing",
    agents: [],
  });
  current.runtime = bed.runtime;
  bed.handlers["agents.create"] = () => created;
  const onClose = vi.fn();
  const onCreated = vi.fn();
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <NewAgentDialog presetField={() => null} onClose={onClose} onCreated={onCreated} />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return { bed, onClose, onCreated };
}

describe("new agent dialog", () => {
  it("shows the form under its title, and hands the new agent over before closing", async () => {
    const { bed, onClose, onCreated } = await open();
    expect(text(document.body)).toContain("New agent");
    await typeInto(field(document.body, "Name"), "atlas");
    await click(button(document.body, "Create agent"));
    await settle();
    expect(bed.called("agents.create")).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the microVM EmptyState instead of the form when the VM stack is unusable", async () => {
    const { bed } = await open(false);
    expect(text(document.body)).toContain(
      "Agents run in microVMs: this machine needs KVM and sudo pap vm setup. See pap doctor.",
    );
    expect(document.querySelector("[data-agent-form]")).toBeNull();
    expect(bed.called("agents.create")).toEqual([]);
  });

  it("closes without creating on Cancel", async () => {
    const { bed, onClose, onCreated } = await open();
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(bed.called("agents.create")).toEqual([]);
  });
});
