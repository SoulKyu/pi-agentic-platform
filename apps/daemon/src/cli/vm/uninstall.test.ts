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
