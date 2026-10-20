import { describe, expect, it } from "vitest";
import { mountPointsOf, sweepCniNetns } from "./netns-sweep.ts";

/*
 * AVM-E62 (b). Mutants (RT-43), each run for real:
 *  - the mount check dropped (every cnitest file unlinked) -> killed by "keeps a mounted namespace".
 *  - the name filter dropped -> killed by "keeps other names".
 */
const DIR = "/run/netns";
const A = "cnitest-00e7dfb7-4c94-50f6-1407-3fb52fb8d433";
const B = "cnitest-01038857-4cd4-e4bd-d35e-21704538f681";

function run(names: string[], mounts: string[]) {
  const unlinked: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const removed = sweepCniNetns({
    dir: DIR,
    log: { info: (event, fields) => void logs.push([event, fields]) },
    list: () => names,
    mountinfo: () =>
      mounts.map((point, i) => `${100 + i} 30 0:4 / ${point} rw shared:1 - nsfs nsfs rw`).join("\n"),
    unlink: (file) => void unlinked.push(file),
  });
  return { removed, unlinked, logs };
}

describe("sweepCniNetns", () => {
  it("removes an unmounted cnitest file and says how many", () => {
    const out = run([A, B], []);
    expect(out.unlinked).toEqual([`${DIR}/${A}`, `${DIR}/${B}`]);
    expect(out.removed).toBe(2);
    expect(out.logs).toEqual([["vmd_netns_swept", { removed: 2 }]]);
  });

  it("keeps a mounted namespace", () => {
    const out = run([A, B], [`${DIR}/${A}`]);
    expect(out.unlinked).toEqual([`${DIR}/${B}`]);
  });

  it("keeps other names, and says nothing when it removed nothing", () => {
    const out = run(["cni-1234", "cnitest-x", `${A}.bak`, "default"], []);
    expect(out.unlinked).toEqual([]);
    expect(out.logs).toEqual([]);
  });

  it("goes on after a file that cannot be unlinked", () => {
    const seen: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const removed = sweepCniNetns({
      dir: DIR,
      log: { info: (event, fields) => void logs.push([event, fields]) },
      list: () => [A, B],
      mountinfo: () => "",
      unlink(file) {
        seen.push(file);
        if (file.endsWith(A)) throw new Error("busy");
      },
    });
    expect(seen).toHaveLength(2);
    expect(removed).toBe(1);
    expect(logs).toContainEqual(["vmd_netns_sweep_failed", { failed: 1 }]);
  });

  it("decodes the octal escapes of a mount point", () => {
    expect(mountPointsOf("1 2 0:4 / /run/a\\040b rw - x y z")).toEqual(new Set(["/run/a b"]));
  });
});
