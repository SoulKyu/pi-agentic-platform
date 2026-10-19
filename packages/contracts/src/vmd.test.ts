import { describe, expect, it } from "vitest";
import { VmdRequest, VmdResponse, VmStartResult } from "./vmd.ts";

const hex = (n: number, ch = "a"): string => ch.repeat(n);
const agentId = "helper-1a2b";
const tag = (layer: string): string => `pap-agent-${layer}-${hex(64, "b")}`;
const key = hex(32, "e");
const start = {
  op: "vm.start",
  agentId,
  kind: "thread",
  taskKey: null,
  image: tag("agent"),
  resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
  launchId: hex(32),
  token: hex(64, "c"),
};
const NODE = `docker.io/library/node@sha256:${hex(64, "d")}`;
const valid: Record<string, unknown> = {
  "vm.start": start,
  "vm.start isolated": { ...start, kind: "isolated", taskKey: key },
  "vm.stop": { op: "vm.stop", agentId, taskKey: null },
  "vm.pause": { op: "vm.pause", agentId },
  "vm.resume": { op: "vm.resume", agentId },
  "vm.status": { op: "vm.status", agentId, taskKey: key },
  "vm.list": { op: "vm.list" },
  "disk.create": { op: "disk.create", agentId, taskKey: null, diskMb: 4096 },
  "disk.grow": { op: "disk.grow", agentId, taskKey: null, diskMb: 8192 },
  "disk.delete": { op: "disk.delete", agentId, taskKey: key, purge: false },
  "disk.populate": { op: "disk.populate", agentId, taskKey: null, staging: "migration" },
  "trash.purge": { op: "trash.purge", agentId: null },
  "image.build": {
    op: "image.build",
    layer: "base",
    tag: tag("base"),
    from: NODE,
    aptPackages: ["jq", "g++"],
    upgrade: true,
  },
  "image.list": { op: "image.list" },
  "image.prune": { op: "image.prune", keep: [tag("base")] },
  version: { op: "version" },
  "vmd.health": { op: "vmd.health" },
};

describe("VmdRequest", () => {
  it.each(Object.entries(valid))("parses %s", (_name, request) => {
    expect(VmdRequest.safeParse(request).success).toBe(true);
  });

  // Mutant: drop the `isolated iff taskKey` refine in vm.start. Killed by "ties kind isolated to a task key": an isolated
  // start without a key and a thread start with one both parse without it.
  it("ties kind isolated to a task key", () => {
    expect(VmdRequest.safeParse({ ...start, kind: "isolated" }).success).toBe(false);
    expect(VmdRequest.safeParse({ ...start, taskKey: key }).success).toBe(false);
  });

  it("bounds vm.start's memory, image, environment and token", () => {
    const bad = [
      { resources: { ...start.resources, memoryMb: 511 } },
      { image: "pap-agent-agent-latest" },
      { env: { A: "1" } },
      { token: hex(64, "C") },
    ];
    for (const patch of bad)
      expect(VmdRequest.safeParse({ ...start, ...patch }).success, JSON.stringify(patch)).toBe(false);
  });

  it("gives disk.create, disk.grow and disk.populate the agent's disk only", () => {
    for (const name of ["disk.create", "disk.grow", "disk.populate"]) {
      const request = valid[name] as Record<string, unknown>;
      expect(VmdRequest.safeParse({ ...request, taskKey: key }).success, `${name} with a key`).toBe(false);
      const without: Record<string, unknown> = { ...request };
      delete without.taskKey;
      expect(VmdRequest.safeParse(without).success, `${name} without`).toBe(false);
    }
  });

  it("fails closed on resources: no default fills a missing figure", () => {
    for (const resources of [{}, { memoryMb: 1024, diskMb: 4096 }, { memoryMb: 1024, cpus: 1 }]) {
      expect(VmdRequest.safeParse({ ...start, resources }).success, JSON.stringify(resources)).toBe(false);
    }
    for (const name of ["disk.create", "disk.grow"]) {
      const without: Record<string, unknown> = { ...(valid[name] as Record<string, unknown>) };
      delete without.diskMb;
      expect(VmdRequest.safeParse(without).success, `${name} without diskMb`).toBe(false);
    }
  });

  it("makes vm.stop and vm.status name the VM they mean", () => {
    for (const name of ["vm.stop", "vm.status"]) {
      const without: Record<string, unknown> = { ...(valid[name] as Record<string, unknown>) };
      delete without.taskKey;
      expect(VmdRequest.safeParse(without).success, name).toBe(false);
    }
  });

  it("makes disk.delete name its disk", () => {
    const without: Record<string, unknown> = { ...(valid["disk.delete"] as Record<string, unknown>) };
    delete without.taskKey;
    expect(VmdRequest.safeParse(without).success).toBe(false);
    expect(VmdRequest.safeParse({ ...without, taskKey: null }).success).toBe(true);
  });

  it("refuses an apt name outside SystemPackage and a from that is neither a pinned Node digest nor a pap tag", () => {
    const build = valid["image.build"] as Record<string, unknown>;
    expect(VmdRequest.safeParse({ ...build, aptPackages: ["-o=x"] }).success).toBe(false);
    expect(VmdRequest.safeParse({ ...build, aptPackages: ["a;b"] }).success).toBe(false);
    expect(VmdRequest.safeParse({ ...build, from: "docker.io/library/node:24" }).success).toBe(false);
    expect(VmdRequest.safeParse({ ...build, from: "evil.example/node@sha256:" + hex(64, "d") }).success).toBe(
      false,
    );
    expect(
      VmdRequest.safeParse({ ...build, layer: "agent", tag: tag("agent"), from: tag("base") }).success,
    ).toBe(true);
  });

  it("keeps the layers apart: the tag names the layer, base from Node, the others from a pap tag, no apt in profile", () => {
    const build = valid["image.build"] as Record<string, unknown>;
    const agent = { ...build, layer: "agent", tag: tag("agent"), from: tag("profile") };
    expect(VmdRequest.safeParse(agent).success).toBe(true);
    expect(VmdRequest.safeParse({ ...build, tag: tag("agent") }).success, "tag of another layer").toBe(false);
    expect(VmdRequest.safeParse({ ...build, from: tag("base") }).success, "base from a pap tag").toBe(false);
    expect(VmdRequest.safeParse({ ...agent, from: NODE }).success, "agent from Node").toBe(false);
    const profile = { ...agent, layer: "profile", tag: tag("profile"), from: tag("base") };
    expect(VmdRequest.safeParse(profile).success, "profile with apt").toBe(false);
    expect(VmdRequest.safeParse({ ...profile, aptPackages: [] }).success).toBe(true);
  });

  it("refuses an unknown op and unknown keys", () => {
    expect(VmdRequest.safeParse({ op: "run", command: "id" }).success).toBe(false);
    expect(VmdRequest.safeParse({ op: "vm.list", extra: 1 }).success).toBe(false);
    expect(VmdRequest.safeParse({ ...start, path: "/etc" }).success).toBe(false);
  });
});

describe("responses", () => {
  it("parses an address and a failure code", () => {
    expect(VmStartResult.safeParse({ address: "10.213.0.7" }).success).toBe(true);
    for (const address of ["192.168.0.7", "10.213.0.1", "10.213.0.999", "10.213.0.255", "10.213.0.0"]) {
      expect(VmStartResult.safeParse({ address }).success, address).toBe(false);
    }
    expect(VmdResponse.safeParse({ ok: false, code: "capacity" }).success).toBe(true);
    expect(VmdResponse.safeParse({ ok: false, code: "boom" }).success).toBe(false);
  });
});
