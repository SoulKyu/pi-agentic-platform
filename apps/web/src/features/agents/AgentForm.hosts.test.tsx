// @vitest-environment happy-dom
import { AgentInput, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, mount, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentForm } from "./AgentForm.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const saved: AgentView = {
  id: "atlas-1a2b",
  name: "atlas",
  input: AgentInput.parse({ name: "atlas", allowHosts: ["api.example.com"] }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
};

async function open() {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["agents.update"] = () => saved;
  bed.handlers["plugins.list"] = () => ({ plugins: [] });
  const stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
        <AgentForm agent={saved} presetField={() => null} onSaved={vi.fn()} />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  await typeInto(field(document.body, "Hosts, one per line"), "api.example.com\nk8s.lan:6443");
  await click(button(document.body, "Save"));
  await settle();
  return bed;
}

beforeEach(() => setLocale("en"));

describe("the host list", () => {
  it("sends host:port and IP entries, with no host-mode refusal", async () => {
    const bed = await open();
    expect(document.body.textContent).not.toContain("needs VM mode");
    expect(bed.called("agents.update")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          input: expect.objectContaining({ allowHosts: ["api.example.com", "k8s.lan:6443"] }),
        }),
      }),
    ]);
  });
});
