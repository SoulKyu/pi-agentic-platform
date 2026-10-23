import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ctx, home, unitWith } from "../testing/doctor-fixture.ts";
import { hostMadeAgents, makeSkewChecks, type SkewProbes } from "./checks-vm-skew.ts";
import { makeVmChecks, type VmProbes } from "./checks-vm.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

function probes(over: Partial<SkewProbes> = {}): SkewProbes {
  return { bundles: () => ({ installed: "aa", tree: "aa" }), hostMade: () => [], ...over };
}
async function run(
  id: string,
  over: Partial<SkewProbes> = {},
  context: DoctorContext = ctx(),
): Promise<CheckResult> {
  const check = makeSkewChecks(probes(over)).find((one) => one.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check.run(context);
}

describe("vm.bundle", () => {
  it("is ok when the digests are equal", async () => {
    expect((await run("vm.bundle")).status).toBe("ok");
  });
  it("warns, naming sudo pap vm setup, when they differ", async () => {
    const result = await run("vm.bundle", { bundles: () => ({ installed: "aa", tree: "bb" }) });
    expect(result.status).toBe("warn");
    expect(result.fix).toContain("sudo pap vm setup");
  });
  it("warns when no bundle is installed", async () => {
    expect((await run("vm.bundle", { bundles: () => ({ installed: null, tree: "bb" }) })).status).toBe(
      "warn",
    );
  });
  it("is info when this pap has no bundle of its own", async () => {
    expect((await run("vm.bundle", { bundles: () => ({ installed: "aa", tree: null }) })).status).toBe(
      "info",
    );
  });
});

describe("vm.hostMade", () => {
  it("is ok when none, and lists the names when some", async () => {
    expect((await run("vm.hostMade")).status).toBe("ok");
    const result = await run("vm.hostMade", { hostMade: () => ["Alpha", "Beta"] });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Alpha, Beta");
    expect(result.detail).toContain("delete it and create it again");
  });

  it("flags only a thread whose file is outside the mirrors folder", () => {
    mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec("CREATE TABLE agents (id TEXT, name TEXT, thread_session_id TEXT)");
    db.exec("CREATE TABLE sessions (id TEXT, pi_path TEXT)");
    db.exec(
      "INSERT INTO agents VALUES ('a1','Mirrored','s1'), ('a2','HostMade','s2'), ('a3','NoThread',NULL), ('a4','NeverPrompted','s4')",
    );
    db.prepare(
      "INSERT INTO sessions VALUES ('s1', ?), ('s2', '/home/u/.pi/agent/sessions/x.jsonl'), ('s4', NULL)",
    ).run(join(home, "agents", ".mirrors", "a1", "s1.jsonl"));
    db.close();
    expect(hostMadeAgents(ctx())).toEqual(["HostMade"]);
  });
});

describe("vm.runtimeVar", () => {
  it("is ok with the variable unset", async () => {
    expect((await run("vm.runtimeVar")).status).toBe("ok");
  });
  it("warns when the unit sets it", async () => {
    const result = await run(
      "vm.runtimeVar",
      {},
      ctx({ unit: unitWith({ env: { PAP_AGENTS_RUNTIME: "host" } }) }),
    );
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("the unit");
  });
  it("warns when the shell sets it", async () => {
    const result = await run("vm.runtimeVar", {}, ctx({ env: { PAP_AGENTS_RUNTIME: "vm" } }));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("this shell");
  });
});

describe("the vm.* checks", () => {
  it("run with the variable unset", async () => {
    const vmProbes: VmProbes = {
      papVersion: "1.4.0",
      kvm: () => true,
      stack: async () => ({
        usable: true,
        reason: null,
        vmdVersion: "1.4.0",
        health: { version: "1.4.0", ruleset: true, bridge: true, stateFreeMb: 20_000 },
      }),
      images: async () => [],
      reserved: () => ({ agentDisksMb: 0, keptMirrorsMb: 0 }),
      listeners: () => ({
        gateway: { listening: true, pid: 10 },
        proxy: { listening: true, pid: 10 },
        relay: { listening: true, pid: 11, parent: 10 },
      }),
      firewalls: () => [],
    };
    for (const check of makeVmChecks(vmProbes))
      expect((await check.run(ctx())).status, check.id).not.toBe("skip");
  });
});
