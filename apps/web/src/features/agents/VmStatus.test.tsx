// @vitest-environment happy-dom
import type { VmStatusView } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentVmEn, agentVmFr } from "../../i18n/catalog/agent-vm.ts";
import { setLocale } from "../../i18n/index.ts";
import { button, click, mount, text } from "../../testing/dom.ts";
import { VmStatus } from "./VmStatus.tsx";

const status = (patch: Partial<VmStatusView> = {}): VmStatusView => ({
  runtime: "vm",
  usable: true,
  reason: null,
  vmdVersion: "1.2.3",
  claudeToken: "set",
  agents: [
    { id: "atlas-1a2b", phase: "running" },
    { id: "bolt-0001", phase: "stopped" },
  ],
  ...patch,
});
beforeEach(() => setLocale("en"));

describe("VmStatus", () => {
  it("says the VMs are ready, with pap-vmd's version and how many run", async () => {
    await mount(<VmStatus status={status()} reload={vi.fn()} />);
    const body = text(document.body);
    expect(body).toContain("Agent VMs");
    expect(body).toContain("Ready.");
    expect(body).toContain("pap-vmd 1.2.3");
    expect(body).toContain("1 running");
    expect(body).not.toContain("sudo pap vm setup");
    expect(document.querySelector("[data-vm]")?.getAttribute("data-vm")).toBe("usable");
  });

  it("says what to run, and the daemon's reason, when it is not usable", async () => {
    await mount(
      <VmStatus
        status={status({ usable: false, reason: "pap-vmd is older than pap", vmdVersion: null })}
        reload={vi.fn()}
      />,
    );
    const body = text(document.body);
    expect(body).toContain(agentVmEn["agentVm.unusable"]);
    expect(body).toContain("Reason: pap-vmd is older than pap");
    expect(document.querySelector("[data-vm]")?.getAttribute("data-vm")).toBe("unusable");
  });

  it("draws the reason as plain text, hidden characters removed", async () => {
    await mount(<VmStatus status={status({ usable: false, reason: "<b>x</b>\u202Ey" })} reload={vi.fn()} />);
    expect(document.querySelector("b")).toBeNull();
    expect(text(document.body)).toContain("Reason: <b>x</b>y");
  });

  it("checks again on demand", async () => {
    const reload = vi.fn();
    await mount(<VmStatus status={status()} reload={reload} />);
    await click(button(document.body, "Check again"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("speaks French", async () => {
    setLocale("fr");
    await mount(<VmStatus status={status({ usable: false })} reload={vi.fn()} />);
    expect(text(document.body)).toContain(agentVmFr["agentVm.unusable"]);
    expect(text(document.body)).toContain("sudo pap vm setup");
  });
});
