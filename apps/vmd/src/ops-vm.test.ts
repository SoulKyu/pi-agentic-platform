import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VmdFailure } from "./errors.ts";
import { createLocks } from "./locks.ts";
import { unavailableNet } from "./net-unavailable.ts";
import type { ExecHandler } from "./testing/fake-exec.ts";
import {
  AGENT,
  createFixture,
  IMAGE,
  LAUNCH,
  MIB,
  seedDisk,
  startRequest,
  TASK,
  TOKEN,
  type Fixture,
} from "./testing/ops-fixture.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-token-in-argv: the token is added to a command line (`--env`): killed by "no command line holds the token".
 *  - M-isolated-names-agent-disk: an isolated start uses `diskPath(agent, null)`: killed by "an isolated start never names the
 *    agent's disk".
 *  - M-env-file-kept-on-failure: the env file is removed only when `nerdctl run` succeeds (both the `finally` after the run and
 *    the failure cleanup's removal dropped; each alone is covered by the other): killed by "a failed run leaves no env file".
 *  - M-volume-remove-skipped: the cleanup after a failure skips `direct-volume remove`: killed by "a failed run removes the
 *    container, the volume and the port".
 *  - M-no-rm-before-run: no leftover `rm --force` before `run`: killed by "rm --force runs before every run".
 *  - M-env-file-cleanup-dropped (I3): the failure cleanup no longer removes the env file (only `withStart`'s `finally` does):
 *    killed by "an env file written before a start that never ran is removed" (a `withStart` that rejects).
 *  - M-disk-removed-after-rm-failed (I4): the task disk is removed although `rm --force` failed: killed by "a cleanup rm that
 *    fails is logged by class and keeps the task disk".
 *  - M-task-disk-kept: a failed isolated start keeps its task disk: killed by "a failed isolated start deletes its task disk".
 */
const VOLUME = (fx: Fixture, name: string): string => path.join(fx.volumeRoot, name);
const isRun = (argv: readonly string[]): boolean => argv.includes("run");
const isRm = (argv: readonly string[]): boolean => argv.includes("rm");
const isAdd = (argv: readonly string[]): boolean => argv.includes("direct-volume") && argv.includes("add");
const isRemove = (argv: readonly string[]): boolean =>
  argv.includes("direct-volume") && argv.includes("remove");

let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());

describe("vm.start", () => {
  beforeEach(() => use());

  it("clears a leftover, adds the volume, runs and attaches the port, in that order", async () => {
    const disk = seedDisk(fx);
    const result = await fx.ops.handle(startRequest());
    expect(result).toEqual({ address: "10.213.0.2" });
    const nerdctl = [
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
    const volume = VOLUME(fx, "pap-helper-1a2b");
    expect(fx.exec.calls).toEqual([
      ["/usr/sbin/nft", "list", "table", "bridge", "pap_agents"],
      ["/usr/sbin/ip", "-o", "link", "show", "pap0"],
      [...nerdctl, "rm", "--force", "pap-helper-1a2b"],
      ["/opt/kata/bin/kata-ctl", "direct-volume", "remove", volume],
      [
        "/opt/kata/bin/kata-ctl",
        "direct-volume",
        "add",
        volume,
        JSON.stringify({
          "volume-type": "directvol",
          device: disk,
          fstype: "ext4",
          metadata: {},
          options: [],
        }),
      ],
      [
        ...nerdctl,
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
        "10.213.0.2",
        "--mac-address",
        "02:70:61:00:00:02",
        "--cpus",
        "1",
        "--memory",
        "1024m",
        "--add-host",
        "llm.internal:10.213.0.1",
        "--add-host",
        "claude.internal:10.213.0.1",
        "--env-file",
        fx.state.envFile(LAUNCH),
        "--read-only",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/tmp",
        "-v",
        `${volume}:/agent`,
        `pap.local/${IMAGE}:1`,
      ],
    ]);
    expect(fx.net.events).toEqual(["allocate", "prepare pap-helper-1a2b", "attach pap-helper-1a2b"]);
  });

  it("rm --force runs before every run", async () => {
    seedDisk(fx);
    await fx.ops.handle(startRequest());
    const rm = fx.exec.calls.findIndex(isRm);
    const run = fx.exec.calls.findIndex(isRun);
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(run);
    expect(fx.exec.calls[rm]).toContain("--force");
  });

  it("writes the env file 0600 for the run and removes it when the run is done", async () => {
    let seen = "";
    let mode = 0;
    use((argv) => {
      if (isRun(argv)) {
        const envFile = argv[argv.indexOf("--env-file") + 1] ?? "";
        seen = readFileSync(envFile, "utf8");
        mode = statSync(envFile).mode & 0o777;
      }
      return undefined;
    });
    const file = path.join(fx.state.root, "run", `${LAUNCH}.env`);
    seedDisk(fx);
    await fx.ops.handle(startRequest());
    expect(seen).toBe(
      `PAP_GATEWAY=10.213.0.1:7841\nPAP_GATEWAY_TOKEN=${TOKEN}\nPAP_LAUNCH_ID=${LAUNCH}\nPAP_AGENT_ID=${AGENT}\nPAP_IMAGE_TAG=${IMAGE}\n`,
    );
    expect(mode).toBe(0o600);
    expect(existsSync(file)).toBe(false);
  });

  it("no command line, log record or answer holds the token", async () => {
    seedDisk(fx);
    const result = await fx.ops.handle(startRequest());
    expect(JSON.stringify(fx.exec.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(fx.logs)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("a thread start without the agent's disk is not_found and runs nothing", async () => {
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "not_found" });
    expect(fx.exec.calls).toEqual([]);
    expect(fx.net.events).toEqual([]);
  });

  it("a failed run leaves no env file", async () => {
    use((argv) => (isRun(argv) ? { code: 1, stderr: "boom" } : undefined));
    seedDisk(fx);
    await expect(fx.ops.handle(startRequest())).rejects.toBeInstanceOf(VmdFailure);
    expect(readdirSync(path.join(fx.state.root, "run"))).toEqual([]);
  });

  it("a failed run removes the container, the volume and the port", async () => {
    use((argv) => (isRun(argv) ? { code: 1 } : undefined));
    seedDisk(fx);
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    const run = fx.exec.calls.findIndex(isRun);
    const after = fx.exec.calls.slice(run + 1);
    expect(after.filter(isRm).map((argv) => argv.at(-1))).toEqual(["pap-helper-1a2b"]);
    expect(after.filter(isRemove)).toEqual([
      ["/opt/kata/bin/kata-ctl", "direct-volume", "remove", VOLUME(fx, "pap-helper-1a2b")],
    ]);
    expect(fx.net.events).toEqual(["allocate", "prepare pap-helper-1a2b", "detach pap-helper-1a2b"]);
  });

  it("a failed volume add is cleaned up: no run, the volume removed again", async () => {
    use((argv) => (isAdd(argv) ? { code: 1 } : undefined));
    seedDisk(fx);
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    expect(fx.exec.calls.some(isRun)).toBe(false);
    expect(fx.exec.calls.filter(isRemove)).toHaveLength(2);
    expect(existsSync(VOLUME(fx, "pap-helper-1a2b"))).toBe(false);
  });

  it("a failed attach removes the container just run, the volume and the port", async () => {
    fx.net.failAttach = true;
    seedDisk(fx);
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    const after = fx.exec.calls.slice(fx.exec.calls.findIndex(isRun) + 1);
    expect(after.some(isRm)).toBe(true);
    expect(after.some(isRemove)).toBe(true);
    expect(fx.net.events).toEqual([
      "allocate",
      "prepare pap-helper-1a2b",
      "attach pap-helper-1a2b",
      "detach pap-helper-1a2b",
    ]);
    expect(readdirSync(path.join(fx.state.root, "run"))).toEqual([]);
  });

  it("an env file written before a start that never ran is removed (R8)", async () => {
    fx.cleanup();
    fx = createFixture(undefined, {
      locks: { ...createLocks(), withStart: () => Promise.reject(new VmdFailure("capacity")) },
    });
    seedDisk(fx);
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "capacity" });
    expect(fx.exec.calls.some(isRun)).toBe(false);
    expect(readdirSync(path.join(fx.state.root, "run"))).toEqual([]);
  });

  it("the throwing net of main refuses every start and runs no container", async () => {
    fx.cleanup();
    fx = createFixture(undefined, { net: unavailableNet });
    seedDisk(fx);
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "unavailable" });
    expect(fx.exec.calls.some((argv) => isRun(argv) || isAdd(argv))).toBe(false);
    expect(() => unavailableNet.allocate("x")).toThrow(VmdFailure);
    await expect(
      unavailableNet.attach("x", { ip: "10.213.0.2", mac: "02:70:61:00:00:02" }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("an unavailable net refuses the start before any container exists", async () => {
    seedDisk(fx);
    fx.net.allocate = () => {
      throw new VmdFailure("unavailable");
    };
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "unavailable" });
    expect(fx.exec.calls.some(isRun)).toBe(false);
  });
});

describe("vm.start, isolated (R30)", () => {
  const taskRequest = (): Record<string, unknown> => startRequest({ kind: "isolated", taskKey: TASK });
  let taskDisk: string;
  const prepare = (handler?: ExecHandler): void => {
    use(handler);
    taskDisk = fx.state.diskPath(AGENT, TASK);
  };
  beforeEach(() => prepare());

  it("an isolated start never names the agent's disk and makes its own blank task disk", async () => {
    let atRun = false;
    prepare((argv) => {
      if (isRun(argv)) atRun = existsSync(taskDisk);
      return undefined;
    });
    const agentDisk = seedDisk(fx);
    await fx.ops.handle(taskRequest());
    expect(JSON.stringify(fx.exec.calls)).not.toContain(agentDisk);
    const add = fx.exec.calls.find(isAdd);
    expect(add?.[3]).toBe(VOLUME(fx, `pap-helper-1a2b-${TASK}`));
    expect(add?.[4]).toBe(
      JSON.stringify({
        "volume-type": "directvol",
        device: taskDisk,
        fstype: "ext4",
        metadata: {},
        options: [],
      }),
    );
    expect(atRun).toBe(true);
    expect(statSync(taskDisk).size).toBe(4096 * MIB);
    expect(statSync(taskDisk).mode & 0o777).toBe(0o600);
    expect(fx.exec.calls).toContainEqual(["/usr/sbin/mkfs.ext4", "-q", "-F", taskDisk]);
    expect(fx.roomAsked).toEqual([4096]);
  });

  it("an isolated start works for an agent with no disk of its own", async () => {
    await expect(fx.ops.handle(taskRequest())).resolves.toEqual({ address: "10.213.0.2" });
  });

  it("a failed isolated start deletes its task disk", async () => {
    prepare((argv) => (isRun(argv) ? { code: 1 } : undefined));
    await expect(fx.ops.handle(taskRequest())).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(taskDisk)).toBe(false);
    expect(existsSync(path.dirname(taskDisk))).toBe(false);
  });

  it("a cleanup rm that fails is logged by class and keeps the task disk", async () => {
    prepare((argv) => {
      if (isRun(argv)) return { code: 1 };
      return isRm(argv) ? { code: 1, stderr: `containerd refused ${TOKEN}` } : undefined;
    });
    await expect(fx.ops.handle(taskRequest())).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(taskDisk)).toBe(true);
    expect(fx.logs).toContainEqual({ event: "vmd_cleanup_failed", fields: { step: "rm", error: "refused" } });
    expect(JSON.stringify(fx.logs)).not.toContain(TOKEN);
    expect(readdirSync(path.join(fx.state.root, "run"))).toEqual([]);
  });

  it("a failed mkfs deletes the half-made task disk and starts nothing", async () => {
    prepare((argv) => (argv[0] === "/usr/sbin/mkfs.ext4" ? { code: 1 } : undefined));
    await expect(fx.ops.handle(taskRequest())).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(path.dirname(taskDisk))).toBe(false);
    expect(fx.exec.calls.some(isRun)).toBe(false);
  });

  it("disk_low refuses before anything is made", async () => {
    fx.room = () => Promise.reject(new VmdFailure("disk_low"));
    await expect(fx.ops.handle(taskRequest())).rejects.toMatchObject({ code: "disk_low" });
    expect(existsSync(path.dirname(taskDisk))).toBe(false);
    expect(fx.exec.calls).toEqual([]);
  });
});
