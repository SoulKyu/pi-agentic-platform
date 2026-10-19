import { describe, expect, it } from "vitest";
import {
  buildArgv,
  directVolumeAddArgv,
  directVolumeRemoveArgv,
  imageRef,
  mkfsArgv,
  rmArgv,
  runArgv,
  vmName,
  type VmPlacement,
} from "./argv.ts";
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
const TOKEN = "c".repeat(64);
const IMAGE = `pap-agent-agent-${"b".repeat(64)}`;
const request: VmStartRequest = {
  op: "vm.start",
  agentId: "helper-1a2b",
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
    "--cap-drop",
    "NET_RAW",
  ],
};

describe("names", () => {
  it("names a thread VM by its agent and a task VM by its agent and key", () => {
    expect(vmName("helper-1a2b", null)).toBe("pap-helper-1a2b");
    expect(vmName("helper-1a2b", "e".repeat(32))).toBe(`pap-helper-1a2b-${"e".repeat(32)}`);
    expect(imageRef(IMAGE)).toBe(`pap.local/${IMAGE}:1`);
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
    expect(argv.filter((part) => part.startsWith("--cap-add"))).toEqual(["--cap-add", "--cap-add"]);
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
      '{"volume-type":"directvol","device":"/var/lib/pap-vm/1000/agents/helper-1a2b/disk.img","fstype":"ext4","metadata":{},"options":[]}',
    ]);
    expect(directVolumeRemoveArgv("/run/pap-vm/vol/pap-helper-1a2b")).toEqual([
      "/opt/kata/bin/kata-ctl",
      "direct-volume",
      "remove",
      "/run/pap-vm/vol/pap-helper-1a2b",
    ]);
  });

  it("mkfs.ext4 runs on a file, with -d only for a staging copy", () => {
    expect(mkfsArgv("/s/disk.img")).toEqual(["/usr/sbin/mkfs.ext4", "-q", "-F", "/s/disk.img"]);
    expect(mkfsArgv("/s/disk.img", "/s/staging/x")).toEqual([
      "/usr/sbin/mkfs.ext4",
      "-q",
      "-F",
      "-d",
      "/s/staging/x",
      "/s/disk.img",
    ]);
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
