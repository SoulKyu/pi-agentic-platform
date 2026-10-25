import { describe, expect, it } from "vitest";
import { VmdImageProgress, VmdRequest, VmdResponse, VmStartResult } from "./vmd.ts";

const hex = (n: number, ch = "a"): string => ch.repeat(n);
const box = { kind: "agent", id: "helper-1a2b" };
const project = { kind: "project", id: "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0" };
const tag = (layer: string): string => `pap-agent-${layer}-${hex(64, "b")}`;
const key = hex(32, "e");
const start = {
  op: "vm.start",
  box,
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
  "vm.stop": { op: "vm.stop", box, taskKey: null },
  "vm.pause": { op: "vm.pause", box },
  "vm.resume": { op: "vm.resume", box },
  "vm.status": { op: "vm.status", box, taskKey: key },
  "vm.list": { op: "vm.list" },
  "disk.create": { op: "disk.create", box, taskKey: null, diskMb: 4096 },
  "disk.grow": { op: "disk.grow", box, taskKey: null, diskMb: 8192 },
  "disk.delete": { op: "disk.delete", box, taskKey: key, purge: false },
  "trash.purge": { op: "trash.purge", box: null },
  "image.build": {
    op: "image.build",
    layer: "base",
    tag: tag("base"),
    from: NODE,
    aptPackages: ["jq", "g++"],
    upgrade: true,
  },
  "image.progress": { op: "image.progress", tag: tag("base") },
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

  it("image.progress takes a tag and nothing else", () => {
    expect(VmdRequest.safeParse({ op: "image.progress" }).success).toBe(false);
    expect(VmdRequest.safeParse({ op: "image.progress", tag: "latest" }).success).toBe(false);
    expect(VmdRequest.safeParse({ op: "image.progress", tag: tag("base"), box }).success).toBe(false);
    expect(VmdImageProgress.safeParse({ building: true, lines: 3, last: { line: "x", at: 1 } }).success).toBe(
      true,
    );
    expect(VmdImageProgress.safeParse({ building: false, lines: 0, last: null }).success).toBe(true);
    const bad = [
      { building: true, lines: 201, last: null },
      { building: true, lines: -1, last: null },
      { building: true, lines: 1, last: { line: "x".repeat(513), at: 1 } },
      { building: true, lines: 1, last: { line: "x", at: -1 } },
      { building: true, lines: 1 },
      { building: true, lines: 1, last: null, extra: 1 },
    ];
    for (const result of bad)
      expect(VmdImageProgress.safeParse(result).success, JSON.stringify(result)).toBe(false);
  });

  // M5: the root API has no disk populate any more (no caller since AVM-E53). Mutant: the schema line back -> this fails.
  it("refuses disk.populate: pap-vmd no longer copies a user folder into a disk", () => {
    const request = { op: "disk.populate", box, taskKey: null, staging: "migration" };
    expect(VmdRequest.safeParse(request).success).toBe(false);
  });

  it("gives disk.create and disk.grow the agent's disk only", () => {
    for (const name of ["disk.create", "disk.grow"]) {
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

  it("accepts a project box for the VM and disk ops, never with a task key", () => {
    const projectStart = { ...start, box: project };
    expect(VmdRequest.safeParse(projectStart).success).toBe(true);
    expect(VmdRequest.safeParse({ ...projectStart, kind: "isolated", taskKey: key }).success).toBe(false);
    expect(VmdRequest.safeParse({ op: "vm.stop", box: project, taskKey: null }).success).toBe(true);
    expect(VmdRequest.safeParse({ op: "vm.stop", box: project, taskKey: key }).success).toBe(false);
    expect(
      VmdRequest.safeParse({ op: "disk.create", box: project, taskKey: null, diskMb: 8192 }).success,
    ).toBe(true);
    expect(
      VmdRequest.safeParse({ op: "disk.delete", box: project, taskKey: key, purge: false }).success,
    ).toBe(false);
    expect(VmdRequest.safeParse({ op: "trash.purge", box: project }).success).toBe(true);
    expect(VmdRequest.safeParse({ ...start, box: { kind: "project", id: "helper-1a2b" } }).success).toBe(
      false,
    );
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
