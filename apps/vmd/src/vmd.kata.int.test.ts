import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hex, listenGateway, skipKata, testAgentId, until, vmd, vmdOk } from "./testing/kata-rig.ts";

/*
 * T20a: pap-vmd on the real stack (Kata 4.2 + Cloud Hypervisor on KVM). Skips with one warning without /dev/kvm or the socket,
 * fails under CI=1. Each VM runs the real base image, whose guest dials the gateway address; a listener on pap0's address
 * stands in for the daemon and records who connected. Mutants (RT-43), each run for real:
 *  - `vm.stop` not removing the container: killed by "runs a thread VM" (status is not `absent`).
 *  - `disk.grow` not refusing under a running VM: killed by "refuses a grow while the VM runs".
 */
const skip = skipKata();
const ASSETS = new URL("../../daemon/src/cli/vm/vm-assets.json", import.meta.url);
const RESOURCES = { memoryMb: 512, cpus: 1, diskMb: 1024 };
const IPV4 = /^10\.213\.0\.\d{1,3}$/;
const BOOT_MS = 90_000;

let baseTag = "";
let imageTag = "";
const digestOf = (name: string): string => createHash("sha256").update(name).digest("hex");
/** The home pap-vmd was set up with: its build folder lives there (AVM-E56). */
const papHome = (): string =>
  (JSON.parse(readFileSync("/etc/pap-vm/config.json", "utf8")) as { papHome: string }).papHome;
let gateway: Awaited<ReturnType<typeof listenGateway>>;
const agents: string[] = [];
const taskKey = (): string => hex(16);
const start = (agentId: string, key: string | null = null) =>
  vmd({
    op: "vm.start",
    agentId,
    kind: key === null ? "thread" : "isolated",
    taskKey: key,
    image: imageTag,
    resources: RESOURCES,
    launchId: hex(16),
    token: hex(32),
  });
const statusOf = async (agentId: string, key: string | null = null): Promise<string> =>
  ((await vmdOk({ op: "vm.status", agentId, taskKey: key })) as { state: string }).state;
const fresh = (): string => {
  const id = testAgentId();
  agents.push(id);
  return id;
};

describe.skipIf(skip)("pap-vmd on the real Kata stack", () => {
  beforeAll(async () => {
    gateway = await listenGateway();
    const listed = (await vmdOk<{ tags: string[] }>({ op: "image.list" })).tags;
    baseTag = `pap-agent-base-${digestOf("t20a-vmd-base")}`;
    const profileTag = `pap-agent-profile-${digestOf("t20a-vmd-profile")}`;
    if (!listed.includes(baseTag)) {
      const assets = JSON.parse(readFileSync(ASSETS, "utf8")) as {
        baseImages: Array<{ name: string; digest: string }>;
      };
      const node = assets.baseImages.find((image) => image.name === "node")?.digest;
      await vmdOk({
        op: "image.build",
        layer: "base",
        tag: baseTag,
        from: `docker.io/library/node@${node}`,
        aptPackages: [],
        upgrade: false,
      });
    }
    // The guest seeds Pi's folder from the image's profile layer: without it the guest exits at its first step.
    if (!listed.includes(profileTag)) {
      const folder = join(papHome(), "vm", "build", "profile", "pi-agent");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, "settings.json"), "{}\n");
      await vmdOk({
        op: "image.build",
        layer: "profile",
        tag: profileTag,
        from: baseTag,
        aptPackages: [],
        upgrade: false,
      });
    }
    imageTag = profileTag;
  });

  afterAll(async () => {
    for (const agentId of agents) {
      const listed = (
        await vmdOk<{ vms: Array<{ agentId: string; taskKey: string | null }> }>({ op: "vm.list" })
      ).vms;
      for (const vm of listed.filter((each) => each.agentId === agentId))
        await vmd({ op: "vm.stop", agentId, taskKey: vm.taskKey });
      await vmd({ op: "disk.delete", agentId, taskKey: null, purge: true });
    }
    await gateway?.close();
  });

  it("answers health with the ruleset and the bridge in place", async () => {
    const health = await vmdOk<{ ruleset: boolean; bridge: boolean; version: string }>({ op: "vmd.health" });
    expect(health).toMatchObject({ ruleset: true, bridge: true });
    expect(await vmdOk({ op: "version" })).toEqual({ version: health.version });
  });

  it("runs a thread VM: create the disk, start, running, its guest reaches the gateway from its own address, stop, delete", async () => {
    const agentId = fresh();
    expect(await vmdOk({ op: "disk.create", agentId, taskKey: null, diskMb: 1024 })).toEqual({
      diskMb: 1024,
    });
    const started = Date.now();
    const answer = await start(agentId);
    expect(answer.ok).toBe(true);
    const address = (answer as { result: { address: string } }).result.address;
    expect(address).toMatch(IPV4);
    expect(await statusOf(agentId)).toBe("running");
    await until(
      "the guest's dial",
      async () => {
        if (gateway.peers.includes(address)) return true;
        const state = await statusOf(agentId);
        if (state !== "running") throw new Error(`the VM is ${state} before its guest dialed`);
        return false;
      },
      BOOT_MS,
    );
    console.info(`T20a vm.start to first guest dial: ${Date.now() - started} ms`);
    const listed = await vmdOk<{ vms: Array<{ agentId: string; state: string }> }>({ op: "vm.list" });
    expect(listed.vms.filter((vm) => vm.agentId === agentId)).toEqual([
      expect.objectContaining({ agentId, state: "running" }),
    ]);

    const stopping = Date.now();
    expect(await vmdOk({ op: "vm.stop", agentId, taskKey: null })).toEqual({ stopped: true });
    console.info(`T20a vm.stop (thread VM): ${Date.now() - stopping} ms`);
    expect(await statusOf(agentId)).toBe("absent");
    expect(await vmdOk({ op: "disk.delete", agentId, taskKey: null, purge: true })).toEqual({
      deleted: true,
    });
    expect((await vmd({ op: "disk.delete", agentId, taskKey: null, purge: true })).ok).toBe(false);
  }, 180_000);

  it("pauses and resumes a VM", async () => {
    const agentId = fresh();
    await vmdOk({ op: "disk.create", agentId, taskKey: null, diskMb: 1024 });
    expect((await start(agentId)).ok).toBe(true);
    expect(await statusOf(agentId)).toBe("running");
    await vmdOk({ op: "vm.pause", agentId });
    expect(await statusOf(agentId)).toBe("paused");
    await vmdOk({ op: "vm.resume", agentId });
    expect(await statusOf(agentId)).toBe("running");
    await vmdOk({ op: "vm.stop", agentId, taskKey: null });
  }, 180_000);

  it("refuses a grow while the VM runs, grows after the stop, never shrinks", async () => {
    const agentId = fresh();
    await vmdOk({ op: "disk.create", agentId, taskKey: null, diskMb: 1024 });
    expect((await start(agentId)).ok).toBe(true);
    expect(await vmd({ op: "disk.grow", agentId, taskKey: null, diskMb: 2048 })).toEqual({
      ok: false,
      code: "conflict",
    });
    await vmdOk({ op: "vm.stop", agentId, taskKey: null });
    expect(await vmdOk({ op: "disk.grow", agentId, taskKey: null, diskMb: 2048 })).toEqual({ diskMb: 2048 });
    expect(await vmd({ op: "disk.grow", agentId, taskKey: null, diskMb: 1024 })).toEqual({
      ok: false,
      code: "bad_request",
    });
  }, 180_000);

  it("gives an isolated VM a disk of its own that goes with its stop, and leaves the agent's disk and VM alone", async () => {
    const agentId = fresh();
    const key = taskKey();
    await vmdOk({ op: "disk.create", agentId, taskKey: null, diskMb: 1024 });
    expect((await start(agentId)).ok).toBe(true);
    expect((await start(agentId, key)).ok).toBe(true);
    expect(await statusOf(agentId, key)).toBe("running");
    expect(await statusOf(agentId)).toBe("running");
    // A running task's disk cannot be deleted from under it.
    expect(await vmd({ op: "disk.delete", agentId, taskKey: key, purge: true })).toEqual({
      ok: false,
      code: "conflict",
    });
    await vmdOk({ op: "vm.stop", agentId, taskKey: key });
    expect(await statusOf(agentId, key)).toBe("absent");
    expect(await statusOf(agentId)).toBe("running");
    // The task disk went with its stop; the agent's disk is still there (a second create is a conflict).
    expect(await vmd({ op: "disk.delete", agentId, taskKey: key, purge: true })).toEqual({
      ok: false,
      code: "not_found",
    });
    await vmdOk({ op: "vm.stop", agentId, taskKey: null });
    expect(await vmd({ op: "disk.create", agentId, taskKey: null, diskMb: 1024 })).toEqual({
      ok: false,
      code: "conflict",
    });
  }, 240_000);
});
