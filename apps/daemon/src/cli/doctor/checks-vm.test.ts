import { describe, expect, it } from "vitest";
import { STACK_REASONS, type StackAssessment } from "../../modules/agent-vm/index.ts";
import { ctx, unitWith } from "../testing/doctor-fixture.ts";
import { makeVmChecks, type VmProbes } from "./checks-vm.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

/*
 * Mutants (RT-43), each run for real in the T18 report:
 *  - M-gate: the `PAP_AGENTS_RUNTIME=vm` gate removed -> "every check skips outside vm mode" fails.
 *  - M-version: `vm.vmd` ignores the version -> the "another version" case fails.
 *  - M-unreachable: `vm.vmd` ok on an unreachable pap-vmd -> the unreachable case fails.
 *  - M-sum: the disk room drops the kept mirrors, or the floor -> the "adds" cases fail.
 *  - M-firewall: an active firewall reads ok -> the firewall cases fail.
 *  - M-fix: a non-ok result without a fix -> the "every non-ok result has a fix" case fails.
 */
const PAP = "1.4.0";
const health = { version: PAP, ruleset: true, bridge: true, stateFreeMb: 20_000 };
const usable: StackAssessment = { usable: true, reason: null, vmdVersion: PAP, health };
const unreachable: StackAssessment = {
  usable: false,
  reason: STACK_REASONS.unreachable,
  vmdVersion: null,
  health: null,
};
const stackWith = (over: Partial<typeof health>): StackAssessment => ({
  ...usable,
  health: { ...health, ...over },
});

function probes(over: Partial<VmProbes> = {}): VmProbes {
  return {
    papVersion: PAP,
    kvm: () => true,
    stack: async () => usable,
    images: async () => [`pap-agent-base-${"a".repeat(64)}`],
    reserved: () => ({ agentDisksMb: 8192, keptMirrorsMb: 100 }),
    listeners: () => ({
      gateway: { listening: true, pid: 10 },
      relay: { listening: true, pid: 11, parent: 10 },
    }),
    firewalls: () => [],
    ...over,
  };
}

const vmCtx = (over: Partial<DoctorContext> = {}): DoctorContext =>
  ctx({ unit: unitWith({ env: { PAP_AGENTS_RUNTIME: "vm" } }), ...over });

async function run(id: string, over: Partial<VmProbes> = {}, context = vmCtx()): Promise<CheckResult> {
  const check = makeVmChecks(probes(over)).find((one) => one.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check.run(context);
}

const IDS = [
  "vm.kvm",
  "vm.vmd",
  "vm.stack",
  "vm.network",
  "vm.images",
  "vm.disk",
  "vm.listeners",
  "vm.firewall",
];

describe("the agent VM checks", () => {
  it("are the eight documented ids, in order, each with a title", () => {
    const checks = makeVmChecks(probes());
    expect(checks.map((check) => check.id)).toEqual(IDS);
    expect(checks.every((check) => check.title.length > 0)).toBe(true);
  });

  it("every check skips outside vm mode, and never asks pap-vmd (M-gate)", async () => {
    let asked = 0;
    const counting = probes({
      stack: async () => (asked++, usable),
      kvm: () => (asked++, true),
      images: async () => (asked++, []),
      reserved: () => (asked++, { agentDisksMb: 0, keptMirrorsMb: 0 }),
      firewalls: () => (asked++, []),
      listeners: () => (
        asked++,
        { gateway: { listening: false, pid: null }, relay: { listening: false, pid: null, parent: null } }
      ),
    });
    for (const check of makeVmChecks(counting)) {
      for (const context of [ctx(), ctx({ unit: unitWith({ env: { PAP_AGENTS_RUNTIME: "host" } }) })]) {
        expect(await check.run(context), check.id).toMatchObject({
          status: "skip",
          detail: "PAP_AGENTS_RUNTIME is not vm: the agents run on the host",
        });
      }
    }
    expect(asked).toBe(0);
  });

  it("reads the mode from the unit when there is one, else from the shell", async () => {
    const shell = ctx({ env: { PAP_AGENTS_RUNTIME: "vm" } });
    expect((await run("vm.kvm", {}, shell)).status).toBe("ok");
    const unitHost = ctx({ unit: unitWith({ env: {} }), env: { PAP_AGENTS_RUNTIME: "vm" } });
    expect((await run("vm.kvm", {}, unitHost)).status).toBe("skip");
  });

  it("a healthy stack is ok on every check", async () => {
    for (const id of IDS) expect((await run(id)).status, id).toBe("ok");
  });

  it("every non-ok result has a fix that names a command or a doc", async () => {
    const broken: Array<[string, Partial<VmProbes>]> = [
      ["vm.kvm", { kvm: () => false }],
      ["vm.vmd", { stack: async () => unreachable }],
      ["vm.stack", { stack: async () => stackWith({ ruleset: false }) }],
      ["vm.network", { stack: async () => stackWith({ bridge: false }) }],
      ["vm.images", { images: async () => [] }],
      ["vm.disk", { stack: async () => stackWith({ stateFreeMb: 10 }) }],
      ["vm.firewall", { firewalls: () => ["ufw"] }],
      [
        "vm.listeners",
        {
          listeners: () => ({
            gateway: { listening: true, pid: 10 },
            relay: { listening: true, pid: 99, parent: 5 },
          }),
        },
      ],
    ];
    for (const [id, over] of broken) {
      const result = await run(id, over);
      expect(result.status, id).not.toBe("ok");
      expect(result.fix, id).toMatch(/\S/);
    }
  });

  it("vm.kvm fails without /dev/kvm and points at the nested-virtualization line (R10)", async () => {
    expect(await run("vm.kvm", { kvm: () => false })).toEqual({
      status: "fail",
      detail: "/dev/kvm does not exist: the agents' VMs need hardware virtualization",
      fix: "enable nested virtualization on the host (docs/agents/install.md, Agent VMs)",
    });
  });

  it("vm.vmd fails on an unreachable pap-vmd with the shared sentence (M-unreachable)", async () => {
    expect(await run("vm.vmd", { stack: async () => unreachable })).toEqual({
      status: "fail",
      detail: STACK_REASONS.unreachable,
      fix: "sudo pap vm setup",
    });
  });

  it("vm.vmd fails on another version and says `sudo pap vm setup` (M-version)", async () => {
    const other: StackAssessment = {
      usable: false,
      reason: STACK_REASONS.version("1.3.0", PAP),
      vmdVersion: "1.3.0",
      health: { ...health, version: "1.3.0" },
    };
    expect(await run("vm.vmd", { stack: async () => other })).toEqual({
      status: "fail",
      detail: "pap-vmd is at version 1.3.0, pap at 1.4.0: run `sudo pap vm setup`",
      fix: "sudo pap vm setup",
    });
    expect((await run("vm.vmd")).detail).toBe(`pap-vmd ${PAP} answers`);
  });

  it("vm.stack and vm.network read the root-only facts, and skip when pap-vmd is not there", async () => {
    expect(await run("vm.stack", { stack: async () => stackWith({ ruleset: false }) })).toMatchObject({
      status: "fail",
      detail: STACK_REASONS.ruleset,
    });
    expect(await run("vm.network", { stack: async () => stackWith({ bridge: false }) })).toMatchObject({
      status: "fail",
      detail: STACK_REASONS.bridge,
    });
    for (const id of ["vm.stack", "vm.network", "vm.images", "vm.disk"]) {
      expect(await run(id, { stack: async () => unreachable }), id).toMatchObject({
        status: "skip",
        detail: "pap-vmd does not answer",
      });
    }
  });

  it("vm.images is informational before the first image, ok after, and warns when the list fails", async () => {
    expect((await run("vm.images", { images: async () => [] })).status).toBe("info");
    expect((await run("vm.images", { images: async () => ["pap-agent-profile-x"] })).status).toBe("info");
    expect((await run("vm.images", { images: async () => null })).status).toBe("warn");
  });

  it("vm.disk adds the agents' disks and the kept mirrors to PAP_MIN_FREE_DISK_MB (M-sum)", async () => {
    // 8192 + 100 + the unit's floor 1024 = 9316.
    const at = (free: number) => run("vm.disk", { stack: async () => stackWith({ stateFreeMb: free }) });
    expect((await at(9316)).status).toBe("ok");
    const short = await at(9315);
    expect(short.status).toBe("warn");
    expect(short.detail).toBe(
      "9315 MB free for the agents' VMs; their disks (8192 MB) and kept mirrors (100 MB) and the floor (1024 MB) add up to 9316 MB",
    );
    // The floor is the unit's PAP_MIN_FREE_DISK_MB.
    const raised = vmCtx({
      unit: unitWith({ env: { PAP_AGENTS_RUNTIME: "vm", PAP_MIN_FREE_DISK_MB: "5000" } }),
    });
    expect(
      (await run("vm.disk", { stack: async () => stackWith({ stateFreeMb: 9316 }) }, raised)).status,
    ).toBe("warn");
    // Without the kept mirrors the same space would pass: they count.
    expect(
      (
        await run("vm.disk", {
          reserved: () => ({ agentDisksMb: 8192, keptMirrorsMb: 0 }),
          stack: async () => stackWith({ stateFreeMb: 9300 }),
        })
      ).status,
    ).toBe("ok");
  });

  it("vm.firewall warns for ufw and for firewalld, naming the ports (M-firewall)", async () => {
    const ufw = await run("vm.firewall", { firewalls: () => ["ufw"] });
    expect(ufw.status).toBe("warn");
    expect(ufw.detail).toBe("ufw is active: it can drop the agents' VMs on ports 7841 and 7842 of pap0");
    expect(ufw.fix).toContain("sudo ufw allow in on pap0");
    const both = await run("vm.firewall", { firewalls: () => ["ufw", "firewalld"] });
    expect(both.detail).toContain("ufw and firewalld are active");
    expect((await run("vm.firewall", { firewalls: () => ["firewalld"] })).fix).toContain("firewall-cmd");
  });

  it("asks pap-vmd once for the whole report of one context", async () => {
    let asked = 0;
    const counting = probes({ stack: async () => (asked++, usable) });
    const context = vmCtx();
    for (const check of makeVmChecks(counting)) await check.run(context);
    expect(asked).toBe(1);
  });

  describe("vm.listeners (AVM-E49 M9b)", () => {
    const gw = { listening: true, pid: 10 };
    const none = { listening: false, pid: null };
    const only = (
      gateway: typeof gw | typeof none,
      relay: { listening: boolean; pid: number | null; parent: number | null },
    ) => ({
      listeners: () => ({ gateway, relay }),
    });
    it("is ok when the relay is a child of the process that holds the gateway", async () => {
      const result = await run("vm.listeners", only(gw, { listening: true, pid: 11, parent: 10 }));
      expect(result.status).toBe("ok");
    });
    it("fails when the relay port is held by a process that is not the gateway holder's child (M-parent)", async () => {
      const result = await run("vm.listeners", only(gw, { listening: true, pid: 99, parent: 5 }));
      expect(result).toMatchObject({ status: "fail" });
      expect(result.detail).toContain("not pap's");
      expect(result.detail).toContain("7842");
    });
    it("fails when a listener's holder cannot be seen (another user's)", async () => {
      expect(
        (
          await run(
            "vm.listeners",
            only({ listening: true, pid: null }, { listening: true, pid: 11, parent: 10 }),
          )
        ).detail,
      ).toContain("7841");
      expect((await run("vm.listeners", only(gw, { listening: true, pid: null, parent: null }))).status).toBe(
        "fail",
      );
    });
    it("warns when only the gateway listens, is info without pap, warns with a lock and no sockets", async () => {
      expect(
        (await run("vm.listeners", only(gw, { listening: false, pid: null, parent: null }))).status,
      ).toBe("warn");
      const idle = only(none, { listening: false, pid: null, parent: null });
      expect((await run("vm.listeners", idle)).status).toBe("info");
      expect((await run("vm.listeners", idle, vmCtx({ lockHeld: true }))).status).toBe("warn");
    });
  });
});
