import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.ts";
import { makeBed, snapshot } from "./testing/bed.ts";
import { runUninstall } from "./uninstall.ts";

/* Mutant: uninstall removes the Kata config without checking pap's first line. Killed by "leaves a Kata config that is
   no longer pap's". Mutant: the opt marker check dropped: "leaves a /opt/pap-vm it did not make". */
const beds: Array<ReturnType<typeof makeBed>> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.cleanup();
});
const bed = () => {
  const made = makeBed();
  beds.push(made);
  return made;
};
const setup = (b: ReturnType<typeof makeBed>) =>
  runSetup({ user: "pap", home: undefined, assets: undefined, devFromTree: false }, b.deps, b.io);

describe("pap vm uninstall", () => {
  it("removes exactly what setup wrote and keeps other owners' files and the state", async () => {
    const b = bed();
    mkdirSync(join(b.roots.state, "1001"), { recursive: true });
    writeFileSync(join(b.roots.state, "1001/disk"), "disk");
    writeFileSync(join(b.roots.units, "other.service"), "other");
    mkdirSync(dirname(b.roots.kataConfig), { recursive: true });
    writeFileSync(join(dirname(b.roots.kataConfig), "other.toml"), "other");
    const before = snapshot(b.root);
    await setup(b);
    expect(snapshot(b.root)).not.toEqual(before);
    expect(await runUninstall({ purge: false }, b.deps, b.io)).toBe(0);
    expect(snapshot(b.root)).toEqual(before);
    expect(b.calls).toContain(
      "systemctl disable --now pap-vmd.service pap-vm-buildkit.service pap-vm-containerd.service",
    );
    expect(b.calls).toContain("ip link delete pap0");
    expect(b.stdout()).toContain("is kept");
  });

  // T20a: what the real stack left behind after an uninstall: nerdctl's lock and default network in the config folder, containerd's
  // runtime folder, CNI's cached results of pap's network, and the units in the "failed" list.
  // Mutants: the config folder kept (removeIfEmpty only) -> "the files nerdctl made"; reset-failed dropped -> same case; another
  // network's CNI results removed -> "keeps another network's".
  it("also removes the files nerdctl, containerd and CNI made, and only those of pap's network", async () => {
    const b = bed();
    await setup(b);
    writeFileSync(join(b.roots.etc, "cni/.nerdctl.lock"), "");
    writeFileSync(join(b.roots.etc, "cni/nerdctl-bridge.conflist"), "{}");
    mkdirSync(join(b.roots.etc, "cni/pap"), { recursive: true });
    mkdirSync(join(b.roots.run, "containerd"), { recursive: true });
    mkdirSync(join(b.roots.cniState, "results"), { recursive: true });
    mkdirSync(join(b.roots.cniState, "networks/pap-agents"), { recursive: true });
    writeFileSync(join(b.roots.cniState, `results/pap-agents-${"c".repeat(64)}-eth0`), "{}");
    writeFileSync(join(b.roots.cniState, "results/other-net-abc-eth0"), "{}");
    await runUninstall({ purge: false }, b.deps, b.io);
    expect(existsSync(b.roots.etc)).toBe(false);
    expect(existsSync(b.roots.run)).toBe(false);
    expect(existsSync(join(b.roots.cniState, `results/pap-agents-${"c".repeat(64)}-eth0`))).toBe(false);
    expect(existsSync(join(b.roots.cniState, "networks"))).toBe(false);
    // Keeps another network's.
    expect(existsSync(join(b.roots.cniState, "results/other-net-abc-eth0"))).toBe(true);
    expect(b.calls).toContain(
      "systemctl reset-failed pap-vm-containerd.service pap-vm-buildkit.service pap-vmd.service",
    );
  });

  // T20a fix 1 (I1): containerd's unit has KillMode=process, so its shims and VMs outlive the stop; the containers go first and a
  // mount left under pap's folders stops the removal. Mutants: the rm skipped -> "removes the containers"; the mount check skipped
  // -> "refuses while a mount is left".
  it("removes the containers of pap's namespace before it stops the units", async () => {
    const b = bed();
    await setup(b);
    b.live.containers = "aaa111aaa111\nbbb222bbb222\n";
    await runUninstall({ purge: false }, b.deps, b.io);
    const rm = b.calls.findIndex((call) => call.endsWith("rm --force aaa111aaa111 bbb222bbb222"));
    const stop = b.calls.findIndex((call) => call.startsWith("systemctl disable --now"));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(stop);
    expect(b.calls[rm]).toContain("--namespace pap ");
    expect(b.calls[rm]).toContain(`--address ${b.roots.run}/containerd.sock`);
  });

  it("refuses while a mount is left under pap's folders and removes nothing", async () => {
    const b = bed();
    await setup(b);
    b.live.mounts = `36 29 0:31 / ${b.roots.run}/containerd/io.containerd.runtime.v2.task/pap/x/rootfs rw - overlay overlay rw\n`;
    const before = snapshot(b.root);
    await expect(runUninstall({ purge: false }, b.deps, b.io)).rejects.toThrow(/still mounted/);
    expect(snapshot(b.root)).toEqual(before);
    b.live.mounts = `36 29 0:31 / ${b.roots.state}/containerd/mnt rw - overlay overlay rw\n`;
    await expect(runUninstall({ purge: true }, b.deps, b.io)).rejects.toThrow(/still mounted/);
    // A mount elsewhere, or one whose path only starts like pap's, does not count.
    b.live.mounts = `36 29 0:31 / ${b.roots.run}-other/x rw - tmpfs tmpfs rw\n37 29 0:32 / /mnt/data rw - ext4 /dev/sda rw\n`;
    await expect(runUninstall({ purge: false }, b.deps, b.io)).resolves.toBe(0);
  });

  it("removes only pap's own CNI results: pap-agents-<64 hex>-<ifname>", async () => {
    const b = bed();
    await setup(b);
    mkdirSync(join(b.roots.cniState, "results"), { recursive: true });
    const own = `pap-agents-${"a".repeat(64)}-eth0`;
    writeFileSync(join(b.roots.cniState, "results", own), "{}");
    writeFileSync(join(b.roots.cniState, "results/pap-agents-x"), "{}");
    await runUninstall({ purge: false }, b.deps, b.io);
    expect(existsSync(join(b.roots.cniState, "results", own))).toBe(false);
    expect(existsSync(join(b.roots.cniState, "results/pap-agents-x"))).toBe(true);
  });

  it("deletes the state only with --purge", async () => {
    const b = bed();
    await setup(b);
    writeFileSync(join(b.roots.state, "x"), "x");
    await runUninstall({ purge: true }, b.deps, b.io);
    expect(existsSync(b.roots.state)).toBe(false);
  });

  it("leaves a Kata config that is no longer pap's", async () => {
    const b = bed();
    await setup(b);
    writeFileSync(b.roots.kataConfig, "# someone else now\n");
    await runUninstall({ purge: false }, b.deps, b.io);
    expect(readFileSync(b.roots.kataConfig, "utf8")).toBe("# someone else now\n");
    expect(b.stdout()).toContain("is not pap's and stays");
  });

  it("leaves a /opt/pap-vm or /opt/kata it did not make", async () => {
    const b = bed();
    for (const dir of [b.roots.opt, b.roots.kata]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mine"), "x");
    }
    await runUninstall({ purge: false }, b.deps, b.io);
    expect(existsSync(join(b.roots.opt, "mine"))).toBe(true);
    expect(existsSync(join(b.roots.kata, "mine"))).toBe(true);
  });

  it("refuses a non-root caller", async () => {
    const b = bed();
    await expect(runUninstall({ purge: false }, { ...b.deps, isRoot: false }, b.io)).rejects.toThrow(/sudo/);
    expect(b.calls).toEqual([]);
  });
});
