// @vitest-environment happy-dom
import { AgentInput, type AgentView, EGRESS_UNKNOWN, type VmStatusView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentVmEn, agentVmFr } from "../../i18n/catalog/agent-vm.ts";
import { sessionPolicyFr } from "../../i18n/catalog/session-policy.ts";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentForm } from "./AgentForm.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const current: { runtime: Runtime | undefined } = { runtime: undefined };

const vmStatus = (patch: Partial<VmStatusView> = {}): VmStatusView => ({
  runtime: "vm",
  usable: true,
  reason: null,
  vmdVersion: "1.0.0",
  claudeToken: "set",
  agents: [],
  ...patch,
});
const saved = (resources = { memoryMb: 2048, cpus: 2, diskMb: 8192 }): AgentView => ({
  id: "atlas-1a2b",
  name: "atlas",
  input: AgentInput.parse({ name: "atlas", resources }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
});

async function open(status: VmStatusView | "fails", agent: AgentView | null = saved()) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["agents.vmStatus"] = () => {
    if (status === "fails") throw new Error("down");
    return status;
  };
  bed.handlers["agents.update"] = () => saved();
  bed.handlers["plugins.list"] = () => ({ plugins: [], truncated: false });
  const stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
        <AgentForm
          agent={agent}
          probe={{ usable: true, path: "/usr/bin/bwrap", reason: null, checkedAt: 5, egress: EGRESS_UNKNOWN }}
          presetField={() => null}
          onSaved={() => {}}
        />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return bed;
}
const body = () => text(document.body);
const say = (label: string, value: string) => typeInto(field(document.body, label), value);
const sentInput = (bed: Awaited<ReturnType<typeof open>>) =>
  (bed.called("agents.update")[0]?.params as { input: AgentInput } | undefined)?.input;

beforeEach(() => setLocale("en"));

describe("agent form: VM resources", () => {
  it("shows memory, CPUs and disk with the saved values and the contract's range", async () => {
    await open(vmStatus());
    expect(field(document.body, "Memory (MiB)").value).toBe("2048");
    expect(field(document.body, "CPUs").value).toBe("2");
    expect(field(document.body, "Disk (MiB)").value).toBe("8192");
    expect(body()).toContain("From 512 to 1048576.");
    expect(body()).toContain("The disk can only be enlarged.");
  });

  it("sends changed resources", async () => {
    const bed = await open(vmStatus());
    await say("Memory (MiB)", "4096");
    await say("Disk (MiB)", "16384");
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed)?.resources).toEqual({ memoryMb: 4096, cpus: 2, diskMb: 16384 });
  });

  it("cannot submit a disk below the saved size", async () => {
    const bed = await open(vmStatus());
    await say("Disk (MiB)", "4096");
    await click(button(document.body, "Save"));
    await settle();
    expect(bed.called("agents.update")).toEqual([]);
    expect(body()).toContain("The disk cannot go below its saved size");
  });

  it("allows the same disk size again", async () => {
    const bed = await open(vmStatus());
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed)?.resources.diskMb).toBe(8192);
  });

  it.each([
    ["Memory (MiB)", "256"],
    ["Memory (MiB)", "2000000"],
    ["CPUs", "0"],
    ["CPUs", "300"],
    ["CPUs", "1.5"],
    ["Disk (MiB)", "70000"],
    ["Memory (MiB)", ""],
  ])("does not send %s = %j", async (label, value) => {
    const bed = await open(vmStatus());
    await say(label, value);
    await click(button(document.body, "Save"));
    await settle();
    expect(bed.called("agents.update")).toEqual([]);
    expect(body()).toContain("Enter a whole number within the range shown.");
  });

  it("says the VM notes: no vault, no prechecks, a shell that is always isolated", async () => {
    await open(vmStatus());
    expect(body()).toContain("Does not apply to VM agents: their shell is always isolated, with no network.");
    expect(body()).toContain("The vault for VM agents arrives with sub-project 2.");
    expect(body()).toContain("Trigger prechecks for a VM agent arrive with sub-project 3.");
    expect(body()).not.toContain("Off is still yours to choose.");
  });

  it("keeps the host form as it is outside VM mode, or when the status cannot be read", async () => {
    for (const status of [vmStatus({ runtime: "host" }), "fails" as const]) {
      document.body.replaceChildren();
      await open(status);
      expect(body()).not.toContain("Memory (MiB)");
      expect(body()).not.toContain("The vault for VM agents");
      expect(body()).toContain("bubblewrap found at /usr/bin/bwrap");
      expect(alerts(document.body)).toEqual([]);
    }
  });
});

describe("the French catalog", () => {
  it("spells its accents", () => {
    expect(agentVmFr["agentVm.memory"]).toContain("Mémoire");
    expect(agentVmFr["agentVm.cpus"]).toBe("Processeurs");
    expect(agentVmFr["agentVm.system.title"]).toBe("Paquets système");
    expect(agentVmFr["agentVm.disk.hint"]).toBe("Le disque ne peut qu'être agrandi.");
    expect(sessionPolicyFr["sessionPolicy.unverified"]).toBe("pas envoyé depuis pap");
  });

  it("carries the owner's sentences word for word", () => {
    expect(agentVmFr["agentVm.sandboxNote"]).toBe(
      "Ne s'applique pas aux agents en VM : leur shell est toujours isolé, sans réseau.",
    );
    expect(agentVmFr["agentVm.vault"]).toBe("Le coffre des agents en VM arrive avec le sous-projet 2.");
    expect(agentVmFr["agentVm.prechecks"]).toBe(
      "Les pré-checks d'un agent en VM arrivent avec le sous-projet 3.",
    );
    expect(agentVmFr["agentVm.exportHtml"]).toBe("L'export HTML d'un agent en VM arrive plus tard.");
    expect(Object.keys(agentVmFr).sort()).toEqual(Object.keys(agentVmEn).sort());
  });
});
