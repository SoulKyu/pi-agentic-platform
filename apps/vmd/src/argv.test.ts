import type { BoxRef } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  buildArgv,
  directVolumeAddArgv,
  directVolumeRemoveArgv,
  imageRef,
  sparseCopyArgv,
  guestShellArgv,
  mkfsArgv,
  rmArgv,
  runArgv,
  diskFlags,
  mountOf,
  type VmPlacement,
} from "./argv.ts";
import { parseVmName, vmName } from "./box-name.ts";
import type { ImageBuildRequest, VmStartRequest } from "./ops.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-token-in-argv: `--env PAP_GATEWAY_TOKEN=<token>` added to `runArgv`: killed by "no element of the run command line holds the token".
 *  - M-privileged: `--privileged` added: killed by "the run command line equals the fixed array" and "never --privileged".
 *  - M-rm-without-force: `rm` without `--force`: killed by "rmArgv equals the fixed array".
 *  - M-base-cache: `--no-cache` dropped from a base build: killed by "a base build has --no-cache".
 */
const NERDCTL = [
  "/opt/pap-vm/bin/nerdctl",
  "--address",
  "/run/pap-vm/containerd.sock",
  "--namespace",
  "pap",
  "--data-root",
  "/var/lib/pap-vm/nerdctl",
  "--cni-path",
  "/opt/pap-vm/libexec/cni",
  "--cni-netconfpath",
  "/etc/pap-vm/cni",
];
const agent: BoxRef = { kind: "agent", id: "helper-1a2b" };
const project: BoxRef = { kind: "project", id: "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0" };
const TOKEN = "c".repeat(64);
const IMAGE = `pap-agent-agent-${"b".repeat(64)}`;
const request: VmStartRequest = {
  op: "vm.start",
  box: agent,
  kind: "thread",
  taskKey: null,
  image: IMAGE,
  resources: { memoryMb: 1536, cpus: 2, diskMb: 4096 },
  launchId: "a".repeat(32),
  token: TOKEN,
};
const placement: VmPlacement = {
  ip: "10.213.0.7",
  mac: "02:70:61:00:00:07",
  disk: ["-v", "/run/pap-vm/vol/pap-helper-1a2b:/agent"],
  envFile: "/var/lib/pap-vm/1000/run/aaaa.env",
  runtime: [
    "--runtime",
    "io.containerd.kata-clh.v2",
    "--cap-add",
    "SYS_ADMIN",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SYS_RESOURCE",
    "--cap-drop",
    "NET_RAW",
  ],
};

describe("names", () => {
  it("names a thread VM by its agent and a task VM by its agent and key", () => {
    expect(vmName(agent, null)).toBe("pap-helper-1a2b");
    expect(vmName(agent, "e".repeat(32))).toBe(`pap-helper-1a2b-${"e".repeat(32)}`);
    expect(imageRef(IMAGE)).toBe(`pap.local/${IMAGE}:1`);
  });

  it("names a project box so it never parses as an agent id", () => {
    const name = vmName(project, null);
    expect(name).toBe("pap_p_0b1c2d3e4f504162" + "8394a5b6c7d8e9f0");
    expect(parseVmName(name)).toEqual({ box: project, taskKey: null });
    expect(parseVmName(`pap-${project.id}`)).toBeNull();
    expect(parseVmName(`pap-p-${project.id.replaceAll("-", "")}`)).toBeNull();
    expect(parseVmName("pap_p_" + "A".repeat(32))).toBeNull();
    expect(parseVmName(`pap_p_${"a".repeat(31)}`)).toBeNull();
    expect(parseVmName(`pap_p_${"a".repeat(32)}-${"e".repeat(32)}`)).toBeNull();
    expect(parseVmName("pap-helper-1a2b")).toEqual({ box: agent, taskKey: null });
    expect(() => vmName(project, "e".repeat(32))).toThrow();
    expect(() => vmName({ kind: "project", id: project.id.toUpperCase() }, null)).toThrow();
  });

  it("mounts a project disk at /boxes/<id> and an agent's at /agent", () => {
    expect(mountOf(project)).toBe(`/boxes/${project.id}`);
    expect(diskFlags(project, "/run/pap-vm/vol/pap_p_x")).toEqual([
      "-v",
      `/run/pap-vm/vol/pap_p_x:/boxes/${project.id}`,
    ]);
    expect(diskFlags(agent, "/run/pap-vm/vol/pap-helper-1a2b")).toEqual([
      "-v",
      "/run/pap-vm/vol/pap-helper-1a2b:/agent",
    ]);
  });
});

describe("nerdctl command lines", () => {
  it("rmArgv equals the fixed array (a leftover container is forced out)", () => {
    expect(rmArgv("pap-helper-1a2b")).toEqual([...NERDCTL, "rm", "--force", "pap-helper-1a2b"]);
  });

  it("the run command line equals the fixed array", () => {
    expect(runArgv(request, placement)).toEqual([
      ...NERDCTL,
      "run",
      "--detach",
      "--pull",
      "never",
      "--name",
      "pap-helper-1a2b",
      "--runtime",
      "io.containerd.kata-clh.v2",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "NET_ADMIN",
      "--cap-add",
      "SYS_RESOURCE",
      "--cap-drop",
      "NET_RAW",
      "--network",
      "pap-agents",
      "--ip",
      "10.213.0.7",
      "--mac-address",
      "02:70:61:00:00:07",
      "--cpus",
      "2",
      "--memory",
      "1536m",
      "--add-host",
      "llm.internal:10.213.0.1",
      "--add-host",
      "claude.internal:10.213.0.1",
      "--env-file",
      "/var/lib/pap-vm/1000/run/aaaa.env",
      "--read-only",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/tmp",
      "-v",
      "/run/pap-vm/vol/pap-helper-1a2b:/agent",
      `pap.local/${IMAGE}:1`,
    ]);
  });

  it("no element of the run command line holds the token, and it is never --privileged", () => {
    const argv = runArgv(request, placement);
    expect(argv.filter((part) => part.includes(TOKEN))).toEqual([]);
    expect(argv).not.toContain("--privileged");
    expect(argv.filter((part) => part.startsWith("--cap-add"))).toEqual([
      "--cap-add",
      "--cap-add",
      "--cap-add",
    ]);
  });

  it("an isolated VM is named by its task key", () => {
    const task = { ...request, kind: "isolated" as const, taskKey: "e".repeat(32) };
    expect(runArgv(task, placement)[NERDCTL.length + 5]).toBe(`pap-helper-1a2b-${"e".repeat(32)}`);
  });
});

describe("kata-ctl and mkfs command lines", () => {
  it("adds a direct-assigned volume with the T0a JSON and removes it by its path", () => {
    expect(
      directVolumeAddArgv(
        "/run/pap-vm/vol/pap-helper-1a2b",
        "/var/lib/pap-vm/1000/agents/helper-1a2b/disk.img",
      ),
    ).toEqual([
      "/opt/kata/bin/kata-ctl",
      "direct-volume",
      "add",
      "/run/pap-vm/vol/pap-helper-1a2b",
      '{"volume-type":"directvol","device":"/var/lib/pap-vm/1000/agents/helper-1a2b/disk.img","fstype":"ext4","metadata":{},"options":["discard"]}',
    ]);
    expect(directVolumeRemoveArgv("/run/pap-vm/vol/pap-helper-1a2b")).toEqual([
      "/opt/kata/bin/kata-ctl",
      "direct-volume",
      "remove",
      "/run/pap-vm/vol/pap-helper-1a2b",
    ]);
  });

  it("copies a disk sparsely by absolute paths, keeping mode, owner and times", () => {
    expect(sparseCopyArgv("/s/disk.img", "/s/disk.img.reclaim")).toEqual([
      "/usr/bin/cp",
      "--sparse=always",
      "--preserve=mode,ownership,timestamps",
      "--",
      "/s/disk.img",
      "/s/disk.img.reclaim",
    ]);
  });

  it("runs a guest shell command as root through pap's own nerdctl", () => {
    const argv = guestShellArgv("pap-helper-1a2b", "sync");
    expect(argv.slice(0, 5)).toEqual([
      "/opt/pap-vm/bin/nerdctl",
      "--address",
      "/run/pap-vm/containerd.sock",
      "--namespace",
      "pap",
    ]);
    expect(argv.slice(-6)).toEqual(["--user", "0", "pap-helper-1a2b", "sh", "-c", "sync"]);
    expect(argv).toContain("exec");
  });

  it("mkfs.ext4 runs on a file and never populates it from a folder", () => {
    expect(mkfsArgv("/s/disk.img")).toEqual(["/usr/sbin/mkfs.ext4", "-q", "-F", "/s/disk.img"]);
  });
});

describe("buildctl command lines (RT-19)", () => {
  const build = (layer: "base" | "profile" | "agent"): ImageBuildRequest => ({
    op: "image.build",
    layer,
    tag: `pap-agent-${layer}-${"1".repeat(64)}`,
    from: layer === "base" ? `docker.io/library/node@sha256:${"9".repeat(64)}` : "pap-agent-base-x",
    aptPackages: [],
    upgrade: false,
  });
  const expected = (layer: "base" | "profile" | "agent", extra: string[]): string[] => [
    "/opt/pap-vm/bin/buildctl",
    "--addr",
    "unix:///run/pap-vm/buildkit.sock",
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    "context=/s/build/x",
    "--local",
    "dockerfile=/s/dockerfiles/x",
    "--output",
    `type=image,name=pap.local/pap-agent-${layer}-${"1".repeat(64)}:1,unpack=true`,
    ...extra,
  ];

  it("a base build has --no-cache and the others do not", () => {
    expect(buildArgv(build("base"), "/s/build/x", "/s/dockerfiles/x")).toEqual(
      expected("base", ["--no-cache"]),
    );
    expect(buildArgv(build("profile"), "/s/build/x", "/s/dockerfiles/x")).toEqual(expected("profile", []));
    expect(buildArgv(build("agent"), "/s/build/x", "/s/dockerfiles/x")).toEqual(expected("agent", []));
  });
});
