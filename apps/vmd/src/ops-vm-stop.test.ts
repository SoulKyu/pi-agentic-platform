import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecHandler } from "./testing/fake-exec.ts";
import {
  AGENT_BOX,
  createFixture,
  PROJECT,
  PROJECT_ID,
  seedDisk,
  startRequest,
  TASK,
  type Fixture,
} from "./testing/ops-fixture.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-task-disk-kept-at-stop: `vm.stop` of a task leaves its disk: killed by "stopping a task deletes its disk".
 *  - M-inspect-unknown-absent (S1 item 10): an unknown or empty inspect text answers `absent`: killed by "reports a VM's state
 *    from nerdctl inspect".
 *  - M-task-disk-deleted-while-held: `vm.stop` deletes the task disk although `rm --force` failed: killed by "a rm that really
 *    fails is reported ... and keeps the task disk".
 */
const VOLUME = (fx: Fixture, name: string): string => path.join(fx.volumeRoot, name);
const isRm = (argv: readonly string[]): boolean => argv.includes("rm");
const isRemove = (argv: readonly string[]): boolean =>
  argv.includes("direct-volume") && argv.includes("remove");

let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());

describe("vm.stop, vm.pause, vm.resume, vm.status, vm.list", () => {
  beforeEach(() => use());

  it("stops a thread VM: rm --force, port, volume; the agent's disk stays", async () => {
    const disk = seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.exec.calls.map((argv) => argv.slice(-3))).toEqual([
      ["rm", "--force", "pap-helper-1a2b"],
      ["direct-volume", "remove", VOLUME(fx, "pap-helper-1a2b")],
      ["--all", "--format", "{{.Names}} {{.Status}}"],
      ["/usr/bin/fallocate", "--dig-holes", disk],
    ]);
    expect(fx.net.events).toEqual(["detach pap-helper-1a2b"]);
    expect(existsSync(disk)).toBe(true);
  });

  it("stopping a task deletes its disk (R30); a container already gone is not an error", async () => {
    use((argv) =>
      isRm(argv) ? { code: 1, stderr: 'level=error msg="1 errors:\\nno such container: x"' } : undefined,
    );
    const file = fx.state.diskPath(AGENT_BOX, TASK);
    await fx.ops.handle(startRequest({ kind: "isolated", taskKey: TASK }));
    expect(existsSync(file)).toBe(true);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.dirname(file))).toBe(false);
    expect(fx.exec.calls.filter(isRm).at(-1)?.slice(-3)).toEqual([
      "rm",
      "--force",
      `pap-helper-1a2b-${TASK}`,
    ]);
  });

  it("a rm that really fails is reported, still removes the port and the volume, and keeps the task disk", async () => {
    use((argv) => (isRm(argv) ? { code: 1, stderr: "containerd: connection refused" } : undefined));
    const file = fx.state.diskPath(AGENT_BOX, TASK);
    await fx.ops.handle(startRequest({ kind: "isolated", taskKey: TASK }));
    fx.exec.calls.length = 0;
    fx.net.events.length = 0;
    await expect(fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK })).rejects.toMatchObject({
      code: "failed",
    });
    expect(fx.net.events).toEqual([`detach pap-helper-1a2b-${TASK}`]);
    expect(fx.exec.calls.filter(isRemove)).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
  });

  it("pauses and resumes the agent's thread VM", async () => {
    await fx.ops.handle({ op: "vm.pause", box: AGENT_BOX });
    await fx.ops.handle({ op: "vm.resume", box: AGENT_BOX });
    expect(fx.exec.calls.map((argv) => argv.slice(-2))).toEqual([
      ["pause", "pap-helper-1a2b"],
      ["unpause", "pap-helper-1a2b"],
    ]);
  });

  it("reports a VM's state from nerdctl inspect, absent when it does not exist", async () => {
    const states: [string, string][] = [
      ["running", "running"],
      ["paused", "paused"],
      ["created", "starting"],
      ["exited", "stopped"],
      ["weird", "running"], // S1 item 10: an unknown or empty state may still hold the disk
      ["", "running"],
      ["removing", "running"],
    ];
    for (const [text, state] of states) {
      use((argv) => (argv.includes("inspect") ? { stdout: `${text}\n` } : undefined));
      await expect(fx.ops.handle({ op: "vm.status", box: AGENT_BOX, taskKey: null })).resolves.toEqual({
        state,
      });
    }
    // T20a (S1 n2): nerdctl 2.4.1's own words for an inspect of a missing name (recorded on the real stack): "no such OBJECT".
    // Mutant: the match back to /no such container/ only -> a stopped VM's status is `failed`, not `absent`.
    use((argv) =>
      argv.includes("inspect")
        ? { code: 1, stderr: 'level=fatal msg="1 errors: [no such object pap-helper-1a2b]"\n' }
        : undefined,
    );
    await expect(fx.ops.handle({ op: "vm.status", box: AGENT_BOX, taskKey: TASK })).resolves.toEqual({
      state: "absent",
    });
    // M-inspect-failure-absent (S1 round 1): any other failure says nothing of the VM, so it is not "absent".
    use((argv) =>
      argv.includes("inspect") ? { code: 1, stderr: "containerd: connection refused" } : undefined,
    );
    await expect(fx.ops.handle({ op: "vm.status", box: AGENT_BOX, taskKey: TASK })).rejects.toMatchObject({
      code: "failed",
    });
    expect(fx.exec.calls[0]?.slice(-4)).toEqual([
      "inspect",
      "--format",
      "{{.State.Status}}",
      `pap-helper-1a2b-${TASK}`,
    ]);
  });

  it("lists a project VM and an agent VM and stops both at boot", async () => {
    const hex = PROJECT_ID.replaceAll("-", "");
    fx.ps = [`pap_p_${hex} Up 1 minute`, "pap-helper-1a2b Up 3 minutes", `pap_p_${hex}-${TASK} Up 1 second`];
    await expect(fx.ops.handle({ op: "vm.list" })).resolves.toEqual({
      vms: [
        { box: PROJECT, taskKey: null, state: "running" },
        { box: AGENT_BOX, taskKey: null, state: "running" },
      ],
    });
    // The VM stack stops what it lists (sweep at boot): both kinds go through the same stop.
    await fx.ops.handle({ op: "vm.stop", box: PROJECT, taskKey: null });
    expect(fx.exec.calls.some((argv) => argv.at(-2) === "--force" && argv.at(-1) === `pap_p_${hex}`)).toBe(
      true,
    );
    expect(
      fx.exec.calls.some(
        (argv) => argv[0] === "/opt/kata/bin/kata-ctl" && argv.at(-1)?.endsWith(`/pap_p_${hex}`) === true,
      ),
    ).toBe(true);
  });

  it("lists pap's VMs only, with their state", async () => {
    fx.ps = [
      "pap-helper-1a2b Up 3 minutes",
      `pap-writer-3c4d-${TASK} Up 1 second (Paused)`,
      "pap-writer-3c4d Exited (0) 2 hours ago",
      "pap-x-1a2b Created",
      "registry-redis Up 2 days",
      "pap-bad_name Up 1 minute",
    ];
    await expect(fx.ops.handle({ op: "vm.list" })).resolves.toEqual({
      vms: [
        { box: { kind: "agent", id: "helper-1a2b" }, taskKey: null, state: "running" },
        { box: { kind: "agent", id: "writer-3c4d" }, taskKey: TASK, state: "paused" },
        { box: { kind: "agent", id: "writer-3c4d" }, taskKey: null, state: "stopped" },
        { box: { kind: "agent", id: "x-1a2b" }, taskKey: null, state: "starting" },
      ],
    });
    expect(fx.exec.calls[0]?.slice(-4)).toEqual(["ps", "--all", "--format", "{{.Names}} {{.Status}}"]);
  });

  it("runningTasks names the task VMs that exist and are not stopped", async () => {
    fx.ps = [
      `pap-writer-3c4d-${TASK} Up 1 second`,
      `pap-writer-3c4d-${"f".repeat(32)} Exited (1) 1 hour ago`,
      "pap-helper-1a2b Up 1 minute",
    ];
    await expect(fx.ops.runningTasks()).resolves.toEqual([
      { box: { kind: "agent", id: "writer-3c4d" }, taskKey: TASK },
    ]);
  });

  it("a failing nerdctl ps is failed (never an empty list)", async () => {
    fx.psCode = 1;
    await expect(fx.ops.handle({ op: "vm.list" })).rejects.toMatchObject({ code: "failed" });
  });
});

describe("what a start leaves behind", () => {
  it("creates the volume folder 0700 only under the volume root and removes it at stop", async () => {
    use();
    seedDisk(fx);
    await fx.ops.handle(startRequest());
    const volume = VOLUME(fx, "pap-helper-1a2b");
    expect(lstatSync(volume).isDirectory()).toBe(true);
    expect(statSync(volume).mode & 0o777).toBe(0o700);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    expect(existsSync(volume)).toBe(false);
  });
});
